import { describe, expect, it } from 'vitest';
import demo from '../../fixtures/demo-novi-sad.json';
import { compareHouseNumbers, formatHouseNumber, parseHouseNumber } from './houseNumber';
import { createResolver, DataError, formatRange } from './resolve';
import type { CityData, HouseNumber } from './types';

const data = demo as CityData;
const resolver = createResolver(data);
const h = (s: string): HouseNumber => parseHouseNumber(s)!;
const people = (r: ReturnType<typeof resolver.resolve>) =>
  r.kind === 'rules' ? r.assignments.map((a) => a.people.primary) : [];

describe('parseHouseNumber', () => {
  it('parses plain, suffixed and sub-numbers', () => {
    expect(h('15')).toEqual({ n: 15, suffix: '', sub: null });
    expect(h('15а')).toEqual({ n: 15, suffix: 'a', sub: null }); // Cyrillic а
    expect(h('15a')).toEqual({ n: 15, suffix: 'a', sub: null }); // Latin a
    expect(h('15/2')).toEqual({ n: 15, suffix: '', sub: 2 });
    expect(h(' 15 б / 3 ')).toEqual({ n: 15, suffix: 'b', sub: 3 });
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'abc', '-3', '15ab', '1.5', '15/']) expect(parseHouseNumber(bad)).toBeNull();
  });

  it('sorts naturally and formats back', () => {
    const sorted = ['17', '15/2', '15б', '15', '15а', '9'].map(h).sort(compareHouseNumbers).map(formatHouseNumber);
    expect(sorted).toEqual(['9', '15', '15a', '15b', '15/2', '17']);
  });
});

describe('resolve: rules', () => {
  it('"до 15" and "од 15" both apply to 15, flagged as border', () => {
    const r = resolver.resolve('futoska', h('15'));
    expect(r.kind).toBe('rules');
    if (r.kind !== 'rules') return;
    expect(r.border).toBe(true);
    expect(people(r)).toEqual(['Петар П.', 'Мира М.']);
  });

  it('suffix of a border number keeps it border (15а is in "од 15" and "до 15")', () => {
    const r = resolver.resolve('futoska', h('15а'));
    expect(r.kind === 'rules' && r.border).toBe(true);
  });

  it('numbers below the border match only the lower rule', () => {
    const r = resolver.resolve('futoska', h('7'));
    expect(r.kind === 'rules' && r.border).toBe(false);
    expect(people(r)).toEqual(['Петар П.']);
  });

  it('open end ("крај") and parity: odd above 15 → Мира, even above 15 → territory default', () => {
    expect(people(resolver.resolve('futoska', h('21')))).toEqual(['Мира М.']);
    const even = resolver.resolve('futoska', h('20'));
    expect(even.kind === 'rules' && even.assignments[0]?.territory.id).toBe('15');
    expect(people(even)).toEqual(['Јован Ј.']); // no rule assignee → territory default
  });

  it('even number not covered by any rule falls through to unassigned', () => {
    // 14 is even, ≤15: covered by "до 15"; 16 even covered by third rule. Use a street with rules only for odd.
    const custom = createResolver({
      ...data,
      rules: [{ streetId: 'futoska', from: 1, to: null, parity: 'odd', territoryId: '14' }],
    });
    expect(custom.resolve('futoska', h('4')).kind).toBe('unassigned');
  });
});

describe('resolve: linear, inherited, unassigned', () => {
  it('no number on a split street gives ordered segments', () => {
    const r = resolver.resolve('futoska', null);
    expect(r.kind).toBe('linear');
    if (r.kind !== 'linear') return;
    expect(r.segments.map((s) => formatRange(s.rule!))).toEqual([
      'бр. 1–15',
      'бр. 15–крај (непарни)',
      'бр. 16–крај (парни)',
    ]);
  });

  it('internal street inherits the territory default, with or without number', () => {
    for (const house of [null, h('3')]) {
      const r = resolver.resolve('jevrejska', house);
      expect(r.kind).toBe('inherited');
      if (r.kind === 'inherited') {
        expect(r.assignment.territory.id).toBe('14');
        expect(r.assignment.people).toEqual({ primary: 'Петар П.', deputy: 'Мира М.' });
      }
    }
  });

  it('same name in two settlements resolves independently', () => {
    const a = resolver.resolve('skolska-ns', null);
    const b = resolver.resolve('skolska-pv', null);
    expect(a.kind === 'inherited' && a.assignment.territory.id).toBe('14');
    expect(b.kind === 'inherited' && b.assignment.territory.id).toBe('15');
  });

  it('street in neither rules nor polygon is unassigned', () => {
    expect(resolver.resolve('nedodeljena', h('1')).kind).toBe('unassigned');
  });
});

describe('createResolver validation', () => {
  it('reports every broken reference at once', () => {
    const bad: CityData = {
      ...data,
      rules: [
        { streetId: 'nema', from: 1, to: 5, parity: 'all', territoryId: '14' },
        { streetId: 'futoska', from: 9, to: 3, parity: 'all', territoryId: '99' },
      ],
    };
    try {
      createResolver(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DataError);
      expect((e as DataError).problems).toHaveLength(3);
    }
  });
});

describe('formatRange', () => {
  it('labels open and bounded ranges', () => {
    expect(formatRange({ from: null, to: null, parity: 'all' })).toBe('сви бројеви');
    expect(formatRange({ from: null, to: 15, parity: 'all' })).toBe('бр. 1–15');
    expect(formatRange({ from: 15, to: null, parity: 'even' })).toBe('бр. 15–крај (парни)');
  });
});
