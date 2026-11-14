import type reference from '../../profiles/teritorije/profile.json';

// What the deployment calls a "territory" and its "capital" (UI texts, app name): profiles/<name>/profile.json.
// The code itself always says territory/capital; only the words people read come from the profile.

/** Shape of every profile; profiles/teritorije/profile.json is the reference (see profiles/README.md). */
export type Profile = typeof reference;
export type TextKey = keyof Profile['text'];

// Injected by vite.config.ts from the active profile (in unit tests always the default one).
declare const __PROFILE__: Profile;

export const profile: Profile = __PROFILE__;

/** Text of the profile with its {placeholders} filled: tr('territory.heading', { id, name }). */
export function tr(key: TextKey, vars: Record<string, string | number> = {}): string {
  return profile.text[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}
