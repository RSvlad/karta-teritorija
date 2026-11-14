import type reference from './teritorije/profile.json';

export type Profile = typeof reference;
export type TextKey = keyof Profile['text'];
export const PROFILES_DIR: string;
export const DEFAULT_PROFILE: string;
export function activeProfileName(): string;
export function listProfiles(): string[];
export function checkProfile(profile: unknown, reference?: unknown): string[];
export function loadProfile(name?: string): Profile;
export function activeProfile(): Profile;
export function format(template: string, vars?: Record<string, string | number>): string;
export function tr(key: TextKey, vars?: Record<string, string | number>): string;
export function profileHook(file: string, name?: string): Promise<Record<string, unknown> | null>;
