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

/** `capital` = the territory's meeting place (exactly one per territory); the others are optional extras. */
export type PlaceKind = 'capital' | 'collector' | 'other';

/** A named point of a territory. Never a private home address (see the Sheet template). */
export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  territoryId: string;
  address: string;
  /** Set by the pipeline from the geocode cache; absent when the address could not be geocoded. */
  lat?: number;
  lng?: number;
  note?: string;
}

export interface CityData {
  city: string;
  name: string;
  updated: string;
  /** Recipient of "report unassigned street" emails. Falls back to VITE_REPORT_EMAIL; no button if neither is set. */
  reportEmail?: string;
  territories: Territory[];
  streets: Street[];
  rules: Rule[];
  internal: InternalStreet[];
  /** Capitals and other points. Data built before #10 has none, so readers treat a missing value as []. */
  places: Place[];
}

export interface HouseNumber {
  n: number;
  /** Normalised letter suffix, '' if none ("15а" → "a"). */
  suffix: string;
  /** Part after "/" ("15/2" → 2). */
  sub: number | null;
}

/** A street on a territory's card. No `segments` = the whole street; `rest` = also the numbers no rule covers. */
export interface TerritoryStreet {
  street: Street;
  segments: Rule[];
  rest: boolean;
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
