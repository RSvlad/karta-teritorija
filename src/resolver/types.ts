export type Parity = 'all' | 'odd' | 'even';

export interface People {
  primary: string;
  deputy?: string;
}

export interface Territory {
  id: string;
  name: string;
  color: string;
  defaults: People;
  note?: string;
}

export interface Street {
  id: string;
  name: string;
  /** Disambiguates the same street name in two settlements. */
  settlement?: string;
}

/** A split of one street by house numbers. `from`/`to` are inclusive; null = open end. */
export interface Rule {
  streetId: string;
  from: number | null;
  to: number | null;
  parity: Parity;
  territoryId: string;
  /** Overrides the territory's default people when set. */
  assignee?: string;
  note?: string;
}

/** Street that lies inside a territory polygon (produced by the pipeline). */
export interface InternalStreet {
  streetId: string;
  territoryId: string;
}

export interface CityData {
  city: string;
  name: string;
  updated: string;
  territories: Territory[];
  streets: Street[];
  rules: Rule[];
  internal: InternalStreet[];
}

export interface HouseNumber {
  n: number;
  /** Normalised letter suffix, '' if none ("15а" → "a"). */
  suffix: string;
  /** Part after "/" ("15/2" → 2). */
  sub: number | null;
}

export interface Assignment {
  territory: Territory;
  people: People;
  rule?: Rule;
}

export type Resolution =
  | { kind: 'rules'; street: Street; house: HouseNumber; assignments: Assignment[]; border: boolean }
  | { kind: 'linear'; street: Street; segments: Assignment[] }
  | { kind: 'inherited'; street: Street; house: HouseNumber | null; assignment: Assignment }
  | { kind: 'unassigned'; street: Street; house: HouseNumber | null };
