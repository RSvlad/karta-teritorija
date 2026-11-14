import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkProfile, DEFAULT_PROFILE, format, listProfiles, loadProfile, PROFILES_DIR } from './load.mjs';

// Every profile of the repository must word every text of the default profile (nothing falls back to another
// vocabulary) and keep its {placeholders}. When the template gains a text, a deployment's profile fails here
// until it has its own wording for it: the merge from the template cannot silently show the wrong words.
describe('профили', () => {
  for (const name of listProfiles()) {
    it(`„${name}“ је исправан`, () => {
      expect(loadProfile(name).name).toBe(name);
      expect(checkProfile(loadProfile(name))).toEqual([]);
    });
  }

  it('подразумевани профил постоји', () => {
    expect(listProfiles()).toContain(DEFAULT_PROFILE);
  });

  it('профил са текстом који недостаје или погрешним пољима се одбија', () => {
    const base = loadProfile(DEFAULT_PROFILE);
    const { 'territory.heading': _dropped, ...rest } = base.text;
    expect(checkProfile({ ...base, text: rest })).toContain('нема текста „territory.heading“');
    expect(checkProfile({ ...base, text: { ...base.text, 'territory.heading': 'Територија {id}' } }))
      .toContain('текст „territory.heading“ има поља {id}, а треба {id,name}');
  });

  it('забрањени корен у приказаном тексту се одбија', () => {
    const base = loadProfile(DEFAULT_PROFILE);
    expect(checkProfile({ ...base, forbidden: ['територ'] }).some((p) => p.startsWith('забрањени корен'))).toBe(true);
  });

  it('format попуњава поља, а поље које недостаје је грешка', () => {
    expect(format('Територија {id} „{name}“', { id: 14, name: 'Либерти' })).toBe('Територија 14 „Либерти“');
    expect(() => format('{id}', {})).toThrow();
  });

  // Typos in a key would show up only when that message is first needed; an unused text would rot.
  it('сви текстови који се траже у коду постоје и сваки текст из профила се користи', () => {
    const root = join(PROFILES_DIR, '..');
    const files = ['src', 'data-pipeline', 'scripts']
      .flatMap((dir) => readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && /\.(ts|tsx|mjs|py)$/.test(e.name) && !e.name.includes('.test.'))
        .map((e) => join(e.parentPath ?? e.path, e.name)))
      .filter((f) => !f.includes('node_modules') && !f.includes('/work/') && !f.includes('/cache/'));
    const used = new Set();
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\btr\(\s*['"]([\w.]+)['"]/g)) used.add(m[1]);
    }
    const defined = new Set(Object.keys(loadProfile(DEFAULT_PROFILE).text));
    expect([...used].filter((k) => !defined.has(k))).toEqual([]);
    expect([...defined].filter((k) => !used.has(k))).toEqual([]);
  });
});
