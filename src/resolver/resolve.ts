import type {
  Assignment, CityData, HouseNumber, Parity, Place, Resolution, Rule, Street, Territory, TerritoryStreet,
} from './types';

export class DataError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Неисправни подаци:\n${problems.join('\n')}`);
  }
}

function inRange(rule: Rule, n: number): boolean {
  if (rule.from !== null && n < rule.from) return false;
  if (rule.to !== null && n > rule.to) return false;
  return parityMatches(rule.parity, n);
}

function parityMatches(parity: Parity, n: number): boolean {
  return parity === 'all' || (parity === 'odd') === (n % 2 === 1);
}

const sortKey = (r: Rule): [number, number] => [r.from ?? 0, r.to ?? Infinity];

function bySegment(a: Rule, b: Rule): number {
  const [af, at] = sortKey(a);
  const [bf, bt] = sortKey(b);
  return af - bf || at - bt;
}

export function formatRange(rule: Pick<Rule, 'from' | 'to' | 'parity'>): string {
  const { from, to, parity } = rule;
  const suffix = parity === 'odd' ? ' (непарни)' : parity === 'even' ? ' (парни)' : '';
  if (from === null && to === null) {
    return (parity === 'odd' ? 'сви непарни бројеви' : parity === 'even' ? 'сви парни бројеви' : 'сви бројеви');
  }
  return `бр. ${from ?? 1}–${to ?? 'крај'}${suffix}`;
}

/**
 * Decision order (plan §3):
 * 1. all matching rules for the number; 2. inherited from the territory the street lies in;
 * 3. unassigned. Construction validates references and throws DataError listing every problem.
 */
export function createResolver(data: CityData) {
  const problems: string[] = [];
  const territories = new Map<string, Territory>(data.territories.map((t) => [t.id, t]));
  const streets = new Map<string, Street>(data.streets.map((s) => [s.id, s]));
  const rulesByStreet = new Map<string, Rule[]>();
  const internal = new Map<string, string>();

  for (const r of data.rules) {
    if (!streets.has(r.streetId)) problems.push(`правило: непозната улица "${r.streetId}"`);
    if (!territories.has(r.territoryId)) problems.push(`правило за "${r.streetId}": непозната територија "${r.territoryId}"`);
    if (r.from !== null && r.to !== null && r.from > r.to) problems.push(`правило за "${r.streetId}": од ${r.from} је веће од до ${r.to}`);
    const list = rulesByStreet.get(r.streetId) ?? [];
    list.push(r);
    rulesByStreet.set(r.streetId, list);
  }
  for (const i of data.internal) {
    if (!streets.has(i.streetId)) problems.push(`унутрашња улица: непозната улица "${i.streetId}"`);
    if (!territories.has(i.territoryId)) problems.push(`унутрашња улица "${i.streetId}": непозната територија "${i.territoryId}"`);
    if (internal.has(i.streetId)) problems.push(`унутрашња улица "${i.streetId}" је у више територија`);
    internal.set(i.streetId, i.territoryId);
  }
  const places = data.places ?? [];
  const placeIds = new Set<string>();
  const capitals = new Map<string, Place>();
  for (const p of places) {
    if (placeIds.has(p.id)) problems.push(`тачка "${p.id}" се понавља`);
    placeIds.add(p.id);
    if (!territories.has(p.territoryId)) problems.push(`тачка "${p.id}": непозната територија "${p.territoryId}"`);
    if (p.kind === 'capital') {
      if (capitals.has(p.territoryId)) problems.push(`територија "${p.territoryId}" има више од једне престонице`);
      capitals.set(p.territoryId, p);
    }
  }
  if (problems.length) throw new DataError(problems);

  const assignmentFor = (territory: Territory, rule?: Rule): Assignment => ({
    territory,
    people: rule?.assignee ? { primary: rule.assignee } : territory.defaults,
    rule,
  });
  const fromRule = (r: Rule) => assignmentFor(territories.get(r.territoryId)!, r);

  return {
    streets: data.streets,
    places,
    territories,

    /** The meeting place of a territory, if the data has one. */
    capitalOf(territoryId: string): Place | undefined {
      return capitals.get(territoryId);
    },

    /**
     * Streets of a territory for its printed card, by name: streets it owns by rules (with the ranges)
     * and streets lying inside it. `rest` = it also owns the numbers no rule covers (a street inside it that has rules).
     */
    streetsOf(territoryId: string): TerritoryStreet[] {
      const found = new Map<string, TerritoryStreet>();
      for (const [streetId, rules] of rulesByStreet) {
        const own = rules.filter((r) => r.territoryId === territoryId).sort(bySegment);
        if (own.length) found.set(streetId, { street: streets.get(streetId)!, segments: own, rest: internal.get(streetId) === territoryId });
      }
      for (const [streetId, owner] of internal) {
        if (owner === territoryId && !found.has(streetId)) {
          found.set(streetId, { street: streets.get(streetId)!, segments: [], rest: false });
        }
      }
      return [...found.values()].sort((a, b) => a.street.name.localeCompare(b.street.name, 'sr'));
    },

    resolve(streetId: string, house: HouseNumber | null): Resolution {
      const street = streets.get(streetId);
      if (!street) throw new Error(`Непозната улица: ${streetId}`);
      const rules = rulesByStreet.get(streetId) ?? [];

      if (house && rules.length) {
        const matches = rules.filter((r) => inRange(r, house.n)).sort(bySegment);
        if (matches.length) {
          const assignments = matches.map(fromRule);
          const distinct = new Set(
            assignments.map((a) => `${a.territory.id}|${a.people.primary}|${a.people.deputy ?? ''}`),
          );
          return { kind: 'rules', street, house, assignments, border: distinct.size > 1 };
        }
      }

      if (!house && rules.length) {
        return { kind: 'linear', street, segments: [...rules].sort(bySegment).map(fromRule) };
      }

      const territoryId = internal.get(streetId);
      if (territoryId) {
        return { kind: 'inherited', street, house, assignment: assignmentFor(territories.get(territoryId)!) };
      }
      return { kind: 'unassigned', street, house };
    },
  };
}

export type Resolver = ReturnType<typeof createResolver>;
