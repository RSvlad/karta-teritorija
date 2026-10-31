// Pure transformation: rows read from the Sheet -> CityData (src/resolver/types.ts).
// No I/O here, so it can be checked without network access.

export class PipelineError extends Error {
  constructor(problems) {
    super(`Неисправни подаци у Sheet-у:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const COLUMNS = {
  territories: {
    id: ['ид', 'id', 'број'],
    name: ['назив', 'име'],
    color: ['боја'],
    primary: ['задужен', 'задужени', 'главни'],
    deputy: ['заменик'],
    note: ['напомена'],
  },
  rules: {
    street: ['улица'],
    settlement: ['насеље', 'место'],
    from: ['од'],
    to: ['до'],
    parity: ['паритет', 'страна'],
    territory: ['територија'],
    assignee: ['задужен', 'задужени'],
    note: ['напомена'],
  },
  places: {
    name: ['назив', 'име'],
    territory: ['територија'],
    kind: ['врста', 'тип'],
    address: ['адреса'],
    note: ['напомена'],
  },
};

const REQUIRED = {
  territories: ['id', 'name', 'color', 'primary'],
  rules: ['street', 'territory'],
  places: ['name', 'territory', 'address'],
};

const KIND = new Map([
  ['престоница', 'capital'], ['prestonica', 'capital'], ['capital', 'capital'],
  ['сабирна', 'collector'], ['sabirna', 'collector'], ['collector', 'collector'],
  ['', 'other'], ['остало', 'other'], ['ostalo', 'other'], ['other', 'other'],
]);

const PARITY = new Map([
  ['', 'all'], ['сви', 'all'], ['сви бројеви', 'all'], ['svi', 'all'], ['all', 'all'],
  ['непарни', 'odd'], ['непарно', 'odd'], ['neparni', 'odd'], ['odd', 'odd'],
  ['парни', 'even'], ['парно', 'even'], ['parni', 'even'], ['even', 'even'],
]);

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'dj', е: 'e', ж: 'z', з: 'z', и: 'i', ј: 'j',
  к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  ћ: 'c', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's',
};

export function slug(text) {
  return [...text.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/đ/g, 'dj')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Turns a raw 2D array (header row first) into [{ row, values: { field: string } }].
 * `row` is the 1-based Sheet row number, used in error messages.
 */
export function readTable(kind, sheetTitle, raw, problems) {
  const spec = COLUMNS[kind];
  const [header = [], ...body] = raw;
  const index = {};
  header.forEach((cell, i) => {
    const name = clean(cell).toLowerCase();
    for (const [field, aliases] of Object.entries(spec)) {
      if (aliases.includes(name) && index[field] === undefined) index[field] = i;
    }
  });
  for (const field of REQUIRED[kind]) {
    if (index[field] === undefined) {
      problems.push(`лист „${sheetTitle}“: нема колоне „${spec[field][0]}“`);
    }
  }
  const rows = [];
  body.forEach((cells, i) => {
    const values = {};
    for (const field of Object.keys(spec)) {
      values[field] = index[field] === undefined ? '' : clean(cells[index[field]]);
    }
    if (Object.values(values).every((v) => v === '')) return;
    rows.push({ row: i + 2, values });
  });
  return rows;
}

function parseBound(text, where, problems) {
  if (text === '') return null;
  if (!/^\d+$/.test(text)) {
    problems.push(`${where}: „${text}“ није цео број`);
    return null;
  }
  return Number(text);
}

export function buildCity({ city, name, reportEmail, updated, territoriesRaw, rulesRaw, placesRaw = null }) {
  const problems = [];
  const territoryRows = readTable('territories', 'Територије', territoriesRaw, problems);
  const ruleRows = readTable('rules', 'Правила', rulesRaw, problems);
  // The "Тачке" tab is optional. Without it the city simply has no places; once it exists,
  // every territory must have exactly one capital.
  const placeRows = placesRaw === null ? null : readTable('places', 'Тачке', placesRaw, problems);

  const territories = [];
  const territoryIds = new Set();
  for (const { row, values: v } of territoryRows) {
    const where = `Територије, ред ${row}`;
    if (!v.id) problems.push(`${where}: нема ид`);
    else if (territoryIds.has(v.id)) problems.push(`${where}: ид „${v.id}“ се понавља`);
    if (!v.name) problems.push(`${where}: нема назива`);
    if (!/^#[0-9a-fA-F]{6}$/.test(v.color)) problems.push(`${where}: боја „${v.color}“ мора бити облика #rrggbb`);
    if (!v.primary) problems.push(`${where}: нема задуженог`);
    territoryIds.add(v.id);
    const t = {
      id: v.id,
      name: v.name,
      color: v.color.toLowerCase(),
      defaults: { primary: v.primary, ...(v.deputy && { deputy: v.deputy }) },
      ...(v.note && { note: v.note }),
    };
    territories.push(t);
  }

  // Street identity is name + settlement; the same name in two settlements stays two streets.
  const streetKey = (street, settlement) => `${street.toLowerCase()}|${settlement.toLowerCase()}`;
  const settlementsByName = new Map();
  for (const { values: v } of ruleRows) {
    if (!v.street) continue;
    const set = settlementsByName.get(v.street.toLowerCase()) ?? new Set();
    set.add(v.settlement);
    settlementsByName.set(v.street.toLowerCase(), set);
  }

  const streetsByKey = new Map();
  const rules = [];
  for (const { row, values: v } of ruleRows) {
    const where = `Правила, ред ${row}`;
    if (!v.street) {
      problems.push(`${where}: нема улице`);
      continue;
    }
    const variants = settlementsByName.get(v.street.toLowerCase());
    if (variants.size > 1 && v.settlement === '') {
      const named = [...variants].filter(Boolean).join(', ');
      problems.push(`${where}: улица „${v.street}“ постоји у више насеља (${named}); наведите насеље`);
      continue;
    }

    const key = streetKey(v.street, v.settlement);
    if (!streetsByKey.has(key)) {
      streetsByKey.set(key, { name: v.street, settlement: v.settlement });
    }

    if (!v.territory) problems.push(`${where}: нема територије`);
    else if (!territoryIds.has(v.territory)) problems.push(`${where}: непозната територија „${v.territory}“`);

    const from = parseBound(v.from, `${where}, колона „од“`, problems);
    const to = parseBound(v.to, `${where}, колона „до“`, problems);
    if (from !== null && to !== null && from > to) problems.push(`${where}: од ${from} је веће од до ${to}`);

    const parity = PARITY.get(v.parity.toLowerCase());
    if (!parity) problems.push(`${where}: непознат паритет „${v.parity}“ (сви, парни или непарни)`);

    rules.push({
      key,
      rule: {
        from,
        to,
        parity: parity ?? 'all',
        territoryId: v.territory,
        ...(v.assignee && { assignee: v.assignee }),
        ...(v.note && { note: v.note }),
      },
    });
  }

  // IDs depend only on name (+ settlement when the name is shared), never on row order,
  // so links built from them stay valid when the Sheet is re-sorted.
  const nameCount = new Map();
  for (const { name: n } of streetsByKey.values()) nameCount.set(n.toLowerCase(), (nameCount.get(n.toLowerCase()) ?? 0) + 1);
  const idByKey = new Map();
  const usedIds = new Map();
  const streets = [];
  for (const [key, s] of streetsByKey) {
    const shared = nameCount.get(s.name.toLowerCase()) > 1;
    const id = shared ? `${slug(s.name)}-${slug(s.settlement)}` : slug(s.name);
    if (!id) {
      problems.push(`улица „${s.name}“: од назива се не може направити ид`);
      continue;
    }
    if (usedIds.has(id)) {
      problems.push(`улице „${usedIds.get(id)}“ и „${s.name}${s.settlement ? ` (${s.settlement})` : ''}“ дају исти ид „${id}“`);
      continue;
    }
    usedIds.set(id, s.name);
    idByKey.set(key, id);
    streets.push({ id, name: s.name, ...(s.settlement && { settlement: s.settlement }) });
  }

  const places = placeRows === null ? [] : buildPlaces(placeRows, territoryIds, territories, problems);

  if (problems.length) throw new PipelineError(problems);

  return {
    city,
    name,
    updated,
    ...(reportEmail && { reportEmail }),
    territories,
    streets,
    rules: rules.map(({ key, rule }) => ({ streetId: idByKey.get(key), ...rule })),
    // Filled by the territory-drawing step (#8); the Sheet only carries explicit rules.
    internal: [],
    places,
  };
}

/**
 * "Тачке" rows -> Place[] (no coordinates yet: those come from the geocode cache, see places.mjs).
 * Exactly one capital per territory; ids depend on the name (plus territory when a name repeats),
 * never on row order.
 */
function buildPlaces(rows, territoryIds, territories, problems) {
  const checked = [];
  const capitals = new Map();
  for (const { row, values: v } of rows) {
    const where = `Тачке, ред ${row}`;
    if (!v.name) problems.push(`${where}: нема назива`);
    if (!v.address) problems.push(`${where}: нема адресе`);
    if (!v.territory) problems.push(`${where}: нема територије`);
    else if (!territoryIds.has(v.territory)) problems.push(`${where}: непозната територија „${v.territory}“`);
    const kind = KIND.get(v.kind.toLowerCase());
    if (!kind) problems.push(`${where}: непозната врста „${v.kind}“ (престоница, сабирна или остало)`);
    if (kind === 'capital' && v.territory) {
      const prev = capitals.get(v.territory);
      if (prev) problems.push(`${where}: територија „${v.territory}“ већ има престоницу (ред ${prev})`);
      else capitals.set(v.territory, row);
    }
    checked.push({ row, v, kind: kind ?? 'other' });
  }
  for (const t of territories) {
    if (!capitals.has(t.id)) problems.push(`Тачке: територија „${t.id}“ (${t.name}) нема престоницу`);
  }

  const nameCount = new Map();
  for (const { v } of checked) nameCount.set(slug(v.name), (nameCount.get(slug(v.name)) ?? 0) + 1);
  const used = new Map();
  const places = [];
  for (const { row, v, kind } of checked) {
    if (!v.name || !v.address || !territoryIds.has(v.territory)) continue; // already reported
    const base = slug(v.name);
    const id = nameCount.get(base) > 1 ? `${base}-${slug(v.territory)}` : base;
    if (!id) {
      problems.push(`Тачке, ред ${row}: од назива „${v.name}“ се не може направити ид`);
      continue;
    }
    if (used.has(id)) {
      problems.push(`Тачке, ред ${row}: тачка „${v.name}“ у територији „${v.territory}“ се понавља (ред ${used.get(id)})`);
      continue;
    }
    used.set(id, row);
    places.push({
      id,
      name: v.name,
      kind,
      territoryId: v.territory,
      address: v.address,
      ...(v.note && { note: v.note }),
    });
  }
  return places;
}
