// The active vocabulary profile: what the app, the Sheet and the build call a "territory" and its "capital".
// Everything a deployment may word differently (UI texts, Sheet tab and column names, build messages) lives in
// profiles/<name>/profile.json; the code and the published data use one neutral internal vocabulary.
// Used by vite.config.ts, the Node pipeline and the e2e tests; Python reads the same JSON (data-pipeline/vocab.py).
//
// Which profile: APP_PROFILE (environment), else the name in profiles/ACTIVE, else DEFAULT_PROFILE.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROFILES_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILE = 'teritorije';

export function activeProfileName() {
  const fromEnv = process.env.APP_PROFILE?.trim();
  if (fromEnv) return fromEnv;
  const file = join(PROFILES_DIR, 'ACTIVE');
  return (existsSync(file) ? readFileSync(file, 'utf8').trim() : '') || DEFAULT_PROFILE;
}

export function listProfiles() {
  return readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PROFILES_DIR, e.name, 'profile.json')))
    .map((e) => e.name);
}

function read(name) {
  const file = join(PROFILES_DIR, name, 'profile.json');
  if (!existsSync(file)) throw new Error(`Профил „${name}“ не постоји (${file}). Доступни: ${listProfiles().join(', ')}.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const placeholders = (template) => new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');

/**
 * Problems of a profile against the reference (the default profile defines which keys exist and which
 * {placeholders} each text takes). A profile must word every text: nothing falls back to another vocabulary.
 */
export function checkProfile(profile, reference = read(DEFAULT_PROFILE)) {
  const problems = [];
  const text = profile.text ?? {};
  for (const key of Object.keys(reference.text)) {
    if (typeof text[key] !== 'string') {
      problems.push(`нема текста „${key}“`);
      continue;
    }
    const want = [...placeholders(reference.text[key])].sort().join(',');
    const have = [...placeholders(text[key])].sort().join(',');
    if (want !== have) problems.push(`текст „${key}“ има поља {${have}}, а треба {${want}}`);
  }
  for (const key of Object.keys(text)) if (!(key in reference.text)) problems.push(`непознат текст „${key}“`);
  for (const [path, ok] of [
    ['app.title', typeof profile.app?.title === 'string' && profile.app.title !== ''],
    ['app.cachePrefix', /^[a-z0-9-]+$/.test(profile.app?.cachePrefix ?? '')],
    ['sheet.territoriesTab', typeof profile.sheet?.territoriesTab === 'string' && profile.sheet.territoriesTab !== ''],
    ['sheet.territoriesTabAliases', Array.isArray(profile.sheet?.territoriesTabAliases) && isStrings(profile.sheet.territoriesTabAliases)],
    ['sheet.territoryColumn', isStrings(profile.sheet?.territoryColumn) && profile.sheet.territoryColumn.length > 0],
    ['sheet.capitalKind', isStrings(profile.sheet?.capitalKind) && profile.sheet.capitalKind.length > 0],
    ['forbidden', isStrings(profile.forbidden ?? [])],
  ]) {
    if (!ok) problems.push(`неисправно поље „${path}“`);
  }
  // `forbidden` lists word stems of another vocabulary that must not appear in what people read. The old
  // names accepted from the Sheet (aliases, column and kind spellings) are exempt: they are input, not output.
  const shown = [profile.app?.title, profile.sheet?.territoriesTab, ...Object.values(text)].filter((s) => typeof s === 'string');
  for (const stem of profile.forbidden ?? []) {
    const hit = shown.find((s) => s.toLowerCase().includes(stem.toLowerCase()));
    if (hit) problems.push(`забрањени корен „${stem}“ у: ${hit}`);
  }
  return problems;
}

/** The named profile (default: the active one), checked. Throws with every problem listed. */
export function loadProfile(name = activeProfileName()) {
  const profile = read(name);
  if (profile.name !== name) throw new Error(`Профил „${name}“: поље name је „${profile.name}“.`);
  const problems = checkProfile(profile);
  if (problems.length) throw new Error(`Профил „${name}“ није исправан:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  return profile;
}

/** Fills {placeholders}; a missing value is a bug in the caller, so it throws instead of printing "undefined". */
export function format(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Нема вредности за {${key}} у: ${template}`);
    return String(vars[key]);
  });
}

/** A module the active profile may ship next to its profile.json (e.g. migrate-previous.mjs), or null. */
export async function profileHook(file, name = activeProfileName()) {
  const path = join(PROFILES_DIR, name, file);
  return existsSync(path) ? import(pathToFileURL(path).href) : null;
}

let active = null;
/** The active profile, loaded and checked once. */
export function activeProfile() {
  active ??= loadProfile();
  return active;
}

/** Text of the active profile: tr('territory.heading', { id, name }). */
export function tr(key, vars) {
  const template = activeProfile().text[key];
  if (typeof template !== 'string') throw new Error(`Профил „${activeProfile().name}“ нема текст „${key}“.`);
  return format(template, vars);
}
