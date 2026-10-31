import { Fragment, options } from 'preact';
import type { ComponentChildren, VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { cyrillicToLatin } from '../i18n/translit';

/**
 * Display preferences: script (Cyrillic/Latin) and colour theme. Both are remembered in this browser only.
 *
 * All text in the app (UI strings and names from the data) is written in Cyrillic. In Latin mode it is
 * transliterated when the virtual DOM is built (see `installScriptHook`), so components need no per-string
 * calls. Search is unaffected: it folds both scripts to the same form.
 */

const SCRIPT_KEY = 'moj-paroh:script';
// Also read by the inline script in index.html, which sets the theme before the first paint.
const THEME_KEY = 'moj-paroh:theme';
const TITLE = 'Територије';

const SCRIPTS = ['cyr', 'lat'] as const;
const THEMES = ['auto', 'light', 'dark'] as const;
export type Script = (typeof SCRIPTS)[number];
export type Theme = (typeof THEMES)[number];

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const saved = localStorage.getItem(key);
    return allowed.find((a) => a === saved) ?? fallback;
  } catch {
    return fallback; // storage can be blocked (private mode): use the default
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice just won't be remembered.
  }
}

let script: Script = read(SCRIPT_KEY, SCRIPTS, 'cyr');
let theme: Theme = read(THEME_KEY, THEMES, 'auto');
const listeners = new Set<() => void>();

/** Text in the chosen script. For strings that are not rendered through JSX (map labels, share text, mailto). */
export function tx(text: string): string {
  return script === 'lat' ? cyrillicToLatin(text) : text;
}

function applyScript(): void {
  document.documentElement.lang = script === 'lat' ? 'sr-Latn' : 'sr-Cyrl';
  document.title = tx(TITLE);
}

function applyTheme(): void {
  // "auto" = no attribute: the stylesheet follows prefers-color-scheme.
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function setScript(next: Script): void {
  script = next;
  write(SCRIPT_KEY, next);
  applyScript();
  listeners.forEach((l) => l());
}

export function setTheme(next: Theme): void {
  theme = next;
  write(THEME_KEY, next);
  applyTheme();
  listeners.forEach((l) => l());
}

/** The theme that follows `current` when the button is pressed: auto → light → dark → auto. */
export function nextTheme(current: Theme): Theme {
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!;
}

/** Re-renders the calling component whenever a preference changes. */
function useSubscription(): void {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
}

export function useScript(): Script {
  useSubscription();
  return script;
}

export function useTheme(): Theme {
  useSubscription();
  return theme;
}

const TEXT_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];

function latinChildren(children: ComponentChildren): ComponentChildren {
  if (typeof children === 'string') return cyrillicToLatin(children);
  if (Array.isArray(children)) return children.map(latinChildren);
  return children;
}

/**
 * Transliterates the text of an element (or fragment) vnode and its accessible-name attributes.
 * Form values (what the user typed) are not touched. An element with translate={false} is left as written,
 * e.g. the button that names the other script.
 */
function transliterateVNode(vnode: VNode): void {
  const isElement = typeof vnode.type === 'string';
  if (!isElement && vnode.type !== Fragment) return; // components render their own elements; text vnodes have no props
  const props = vnode.props as Record<string, unknown>;
  if (isElement && (props.translate === false || props.translate === 'no')) return;
  if (props.children !== undefined) props.children = latinChildren(props.children as ComponentChildren);
  if (isElement) {
    for (const name of TEXT_ATTRIBUTES) {
      const value = props[name];
      if (typeof value === 'string') props[name] = cyrillicToLatin(value);
    }
  }
}

/** Applies the saved preferences to the page and starts transliterating rendered text. Call once, before the first render. */
export function initPrefs(): void {
  const previous = options.vnode;
  options.vnode = (vnode) => {
    if (script === 'lat') transliterateVNode(vnode);
    previous?.(vnode);
  };
  applyScript();
  applyTheme();
}
