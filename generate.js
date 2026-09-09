#!/usr/bin/env node
'use strict';

/**
 * Regenerates airports.json and cities.json from fresh upstream data.
 *
 * Sources:
 *   - OurAirports airports.csv (David Megginson)
 *     https://davidmegginson.github.io/ourairports-data/airports.csv
 *   - OpenTravelData optd_por_public.csv
 *     https://raw.githubusercontent.com/opentraveldata/opentraveldata/master/opentraveldata/optd_por_public.csv
 *
 * Usage: npm run generate  (or: node generate.js)
 *
 * See README.md for details, including how overrides.json is applied.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const CSVToJSON = require('csvtojson');
const countries = require('i18n-iso-countries');
// Pinned (exact) to the version the consuming api-gateway locks: newer
// releases rename countries (Turkey -> Türkiye, Czech Republic -> Czechia),
// which would make the round-trip assertion below diverge from what
// consumers actually run. Bump the two together.
const countryCodeLookup = require('country-code-lookup');

countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const REPO_DIR = __dirname;

const AIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const OTD_POR_URL = 'https://raw.githubusercontent.com/opentraveldata/opentraveldata/master/opentraveldata/optd_por_public.csv';

// The OurAirports snapshot is committed to the repo (small, versioned for diffing).
const AIRPORTS_CSV_PATH = path.join(REPO_DIR, 'airports.csv');
// The OpenTravelData file is large (~tens of MB) and only used transiently to build
// cities.json - it must never be committed, so it lives in the OS temp dir.
const OTD_POR_PATH = path.join(os.tmpdir(), 'optd_por_public.csv');

const AIRPORTS_JSON_PATH = path.join(REPO_DIR, 'airports.json');
const CITIES_JSON_PATH = path.join(REPO_DIR, 'cities.json');
const OVERRIDES_JSON_PATH = path.join(REPO_DIR, 'overrides.json');

// i18n-iso-countries returns some official/long-form names. Overrides serve
// two purposes: common short forms for display, and — the hard constraint —
// every emitted `country` must resolve back through country-code-lookup's
// byCountry(), because consumers feed getCountryFromIATACode() output into
// that exact library (policy country rules, agency market lookup, vehicle
// vendor lookup). buildAirports() asserts this round-trip after generating
// and fails the run if any name doesn't resolve.
const COUNTRY_NAME_OVERRIDES = {
  US: 'United States',
  CN: 'China',
  RU: 'Russia',
  IR: 'Iran',
  TR: 'Turkey',
  TW: 'Taiwan',
  TZ: 'Tanzania',
  LA: 'Laos',
  SY: 'Syria',
  MD: 'Moldova',
  MK: 'North Macedonia',
  VG: 'British Virgin Islands',
  BN: 'Brunei',
  SX: 'Sint Maarten',
  // The names below are country-code-lookup's exact `country` strings — less
  // pretty than the common short forms, but byCountry() matches nothing else.
  WS: 'Western Samoa',
  MM: 'Myanmar (Burma)',
  BS: 'The Bahamas',
  GM: 'The Gambia',
  BQ: 'Bonaire',
  FM: 'Federated States of Micronesia',
  MO: 'Macau',
  FK: 'Falkland Islands (Islas Malvinas)',
  MF: 'Saint Martin',
  XK: 'Republic of Kosovo',
  VI: 'Virgin Islands',
  PS: 'Palestinian Territory',
};

function download(url, dest) {
  console.log(`Downloading ${url}\n  -> ${dest}`);
  // -f makes curl exit non-zero on HTTP errors (so execFileSync throws) instead
  // of silently saving an error page; --retry handles transient network
  // failures. execFileSync spawns curl directly (no shell), so no quoting is
  // needed for dest/url.
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
}

// Retired codes: a booking made while a code was current keeps that code for life (a PBI booked
// in July still says PBI after IATA reassigned it to DJT on 2026-08-18), and the consuming
// services look the airport up by that code for as long as the booking exists — trip type,
// city names in emails, timezone maths, policy country rules. Upstream drops a code the day it
// is retired, so every entry of the previously generated airports.json that the fresh build no
// longer produces is carried forward, marked `retired: true`. Upstream always wins for a code it
// still carries, so a reassigned code resolves to its current airport — and OpenTravelData is
// consulted for the same reason: a code it now lists under another country was reassigned, and
// the previous entry is that code's dead meaning, so it is not carried forward either.
function loadPreviousAirports() {
  // The carry-forward is only as good as this file. A missing or empty one would silently
  // regenerate without any retired code, so fail instead of shipping that.
  if (!fs.existsSync(AIRPORTS_JSON_PATH)) {
    throw new Error(
      `${AIRPORTS_JSON_PATH} is missing; the retired-code carry-forward needs the previously committed file. Restore it (git checkout -- airports.json) before regenerating.`
    );
  }
  const previous = JSON.parse(fs.readFileSync(AIRPORTS_JSON_PATH, 'utf8'));
  if (!Array.isArray(previous) || !previous.length) {
    throw new Error(
      `${AIRPORTS_JSON_PATH} is empty; the retired-code carry-forward needs the previously committed file. Restore it (git checkout -- airports.json) before regenerating.`
    );
  }
  return previous;
}

// Country names in older entries were written straight from i18n-iso-countries ("Russian
// Federation") and do not all satisfy the round-trip assertion in buildAirports(); re-resolve
// them through the ISO code. Names i18n-iso-countries cannot reverse-map are listed here.
const LEGACY_COUNTRY_ISO = {
  'Johnston Atoll': 'UM',
};

function normalizeLegacyCountry(name) {
  if (!name || countryCodeLookup.byCountry(name)) {
    return name;
  }
  const iso = LEGACY_COUNTRY_ISO[name] || countries.getAlpha2Code(name, 'en');
  return iso ? getCountryName(iso) : name;
}

// `otdCountriesByCode` maps each IATA code to the ISO-2 countries of its current OpenTravelData
// records (see buildCities).
function carryForwardRetired(airports, previousAirports, otdCountriesByCode) {
  const known = new Set(airports.map((a) => a.iata));
  const previouslyRetired = new Set(
    previousAirports.filter((a) => a.retired).map((a) => String(a.iata || '').trim().toUpperCase())
  );
  const retired = [];
  const dropped = [];
  const currentAgain = [];
  for (const previous of previousAirports) {
    const iata = String(previous.iata || '').trim().toUpperCase();
    // '\\N' is the OpenFlights placeholder for "no IATA code" in pre-2026 entries.
    if (!iata || iata === '\\N') {
      continue;
    }
    // Upstream carries the code again, so its current entry replaces the retired one.
    if (known.has(iata)) {
      if (previous.retired) {
        currentAgain.push(iata);
      }
      continue;
    }
    const country = normalizeLegacyCountry(previous.country);
    // Reassigned code: OpenTravelData lists it today under another country (OEL: the previous
    // entry says Oryol Yuzhny Airport, United States; today OEL is Orël, RU. BAU: the previous
    // entry says Bauru Airport, Brazil; today BAU is Bari Centrale Railway Station, IT). Carrying
    // the old entry forward would resolve the code to a wrong country with no warning — upstream
    // wins.
    const otdCountries = otdCountriesByCode.get(iata);
    const countryIso = countryCodeLookup.byCountry(country)?.iso2;
    if (otdCountries && countryIso && !otdCountries.has(countryIso)) {
      dropped.push(`${iata} (reassigned: ${country} → ${[...otdCountries].join('/')})`);
      continue;
    }
    // Upstream's own duplicate markers are data-quality removals, not retirements.
    if (/^\[Duplicate\]/i.test(String(previous.name || ''))) {
      dropped.push(`${iata} (${previous.name})`);
      continue;
    }
    known.add(iata);
    retired.push({
      ...previous,
      iata,
      icao: previous.icao === '\\N' ? '' : previous.icao,
      country,
      retired: true,
    });
  }

  // Every code that was retired last run is still current, still retired, or dropped by one of
  // the two rules above — anything else means the carry-forward itself lost data.
  const droppedIatas = new Set(dropped.map((d) => d.split(' ')[0]));
  const lost = [...previouslyRetired].filter((iata) => !known.has(iata) && !droppedIatas.has(iata));
  if (lost.length) {
    throw new Error(`retired codes lost by the carry-forward without a rule: ${lost.join(', ')}`);
  }

  // Review gate: junk upstream removes (placeholder codes, test rows) would otherwise become
  // permanent entries here without anyone noticing.
  const newlyRetired = retired.filter((a) => !previouslyRetired.has(a.iata)).map((a) => a.iata);
  console.log(`Newly retired this run (review before committing): ${newlyRetired.join(', ') || 'none'}`);
  if (currentAgain.length) {
    console.log(`Current again (retired entry replaced by upstream's): ${currentAgain.join(', ')}`);
  }
  if (dropped.length) {
    console.log(`Not carried forward: ${dropped.join('; ')}`);
  }
  return retired;
}

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_JSON_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(OVERRIDES_JSON_PATH, 'utf8').trim();
  if (!raw) {
    return [];
  }
  return JSON.parse(raw);
}

function getCountryName(isoCode) {
  if (!isoCode) {
    console.warn('WARNING: row with empty iso_country - emitting empty country.');
    return '';
  }
  if (Object.prototype.hasOwnProperty.call(COUNTRY_NAME_OVERRIDES, isoCode)) {
    return COUNTRY_NAME_OVERRIDES[isoCode];
  }
  const name = countries.getName(isoCode, 'en');
  if (!name) {
    console.warn(
      `WARNING: i18n-iso-countries could not resolve a name for iso_country "${isoCode}" - falling back to the raw code.`
    );
    return isoCode;
  }
  return name;
}

// One row per IATA: the exported lookups are `find()`-based, so a duplicate
// would resolve arbitrarily. The source is currently duplicate-free; if that
// ever changes upstream, keep the row most likely to be the live airport.
const TYPE_RANK = {
  large_airport: 5,
  medium_airport: 4,
  small_airport: 3,
  seaplane_base: 2,
  heliport: 1,
};

function preferRow(a, b) {
  const aScheduled = a.scheduled_service === 'yes' ? 1 : 0;
  const bScheduled = b.scheduled_service === 'yes' ? 1 : 0;
  if (aScheduled !== bScheduled) return aScheduled > bScheduled ? a : b;
  const aRank = TYPE_RANK[(a.type || '').trim()] || 0;
  const bRank = TYPE_RANK[(b.type || '').trim()] || 0;
  if (aRank !== bRank) return aRank > bRank ? a : b;
  return Number(a.id) <= Number(b.id) ? a : b;
}

async function buildAirports(otdCountriesByCode) {
  // Read before this run overwrites it — see carryForwardRetired.
  const previousAirports = loadPreviousAirports();
  const rows = await CSVToJSON().fromFile(AIRPORTS_CSV_PATH);

  const byIata = new Map();
  for (const row of rows) {
    const iata = (row.iata_code || '').trim();
    if (!iata) {
      continue;
    }
    // Defensive: current data has no closed airports with an iata_code, but skip them if
    // that ever changes upstream.
    if ((row.type || '').trim() === 'closed') {
      continue;
    }

    const existing = byIata.get(iata);
    if (existing) {
      console.warn(`WARNING: duplicate iata_code "${iata}" in source data - keeping one row.`);
      byIata.set(iata, preferRow(existing, row));
    } else {
      byIata.set(iata, row);
    }
  }

  let airports = [];
  for (const row of byIata.values()) {
    // Prefer the curated icao_code column; `ident` is an OurAirports internal id
    // for some rows (e.g. "AU-0456"). Fall back to gps_code when it looks like a
    // real ICAO code, then to ident as a last resort.
    let icao = (row.icao_code || '').trim();
    if (!icao) {
      const gpsCode = (row.gps_code || '').trim();
      icao = /^[A-Z]{4}$/.test(gpsCode) ? gpsCode : row.ident;
    }

    airports.push({
      name: row.name,
      // Strip a trailing parenthetical - OurAirports municipalities carry
      // qualifiers like "Oslo (Gardermoen)" or Italian province markers like
      // "Orio al Serio (BG)". These are display strings in booking flows;
      // lookups are by IATA, so the qualifier only adds noise.
      city: (row.municipality || '').replace(/\s*\([^)]*\)\s*$/, ''),
      country: getCountryName(row.iso_country),
      iata: (row.iata_code || '').trim(),
      icao,
      latitude: row.latitude_deg,
      longitude: row.longitude_deg,
    });
  }

  // Apply manual overrides (see overrides.json / README.md) before sorting and
  // assigning ids, so overridden/new entries participate in both.
  const overrides = loadOverrides();
  for (const override of overrides) {
    if (!override || !override.iata) {
      console.warn('WARNING: skipping override entry with no "iata" field:', override);
      continue;
    }
    const idx = airports.findIndex((a) => a.iata === override.iata);
    if (idx === -1) {
      airports.push(
        Object.assign(
          { name: '', city: '', country: '', iata: override.iata, icao: '', latitude: '', longitude: '' },
          override
        )
      );
    } else {
      airports[idx] = Object.assign({}, airports[idx], override);
    }
  }

  const retired = carryForwardRetired(airports, previousAirports, otdCountriesByCode);
  airports.push(...retired);
  console.log(`Carried forward ${retired.length} retired IATA codes from the previous airports.json`);

  airports.sort((a, b) => {
    if (a.iata < b.iata) return -1;
    if (a.iata > b.iata) return 1;
    return 0;
  });

  airports = airports.map((a, i) => ({
    id: String(i + 1),
    name: String(a.name ?? ''),
    city: String(a.city ?? ''),
    country: String(a.country ?? ''),
    iata: String(a.iata ?? ''),
    icao: String(a.icao ?? ''),
    latitude: String(a.latitude ?? ''),
    longitude: String(a.longitude ?? ''),
    ...(a.retired ? { retired: true } : {}),
  }));

  // Hard constraint (see COUNTRY_NAME_OVERRIDES): every emitted country name
  // must resolve through country-code-lookup's byCountry(). Fail the run
  // rather than ship names the consuming code can't resolve.
  const unresolvable = [...new Set(airports.map((a) => a.country))].filter(
    (name) => !name || !countryCodeLookup.byCountry(name)
  );
  if (unresolvable.length) {
    throw new Error(
      `country names not resolvable via country-code-lookup.byCountry(): ${unresolvable.join(', ')} - add COUNTRY_NAME_OVERRIDES entries with that library's exact "country" strings.`
    );
  }

  fs.writeFileSync(AIRPORTS_JSON_PATH, JSON.stringify(airports));
  return airports;
}

// Returns the cities it wrote and `countriesByCode`: the ISO-2 country of every current
// OpenTravelData record, keyed by IATA code, for the reassignment check in carryForwardRetired.
// Every location type counts, not only cities: a code reassigned to a railway or bus station
// (BAU: Bauru Airport, BR → Bari Centrale Railway Station, IT) has no city record, and a
// city-only map would let its dead entry through. A few codes have current records in two
// countries (BSL: FR and CH), hence a set per code.
function buildCities() {
  const raw = fs.readFileSync(OTD_POR_PATH, 'utf8');
  const lines = raw.split('\n');
  // Drop the header row - it must not be emitted as a data entry.
  const dataLines = lines.slice(1);

  // 0-based column indices in optd_por_public.csv (51 caret-separated columns).
  const IATA_IDX = 0;
  const ENVELOPE_IDX = 5;
  const NAME_IDX = 6;
  const LAT_IDX = 8;
  const LON_IDX = 9;
  const COUNTRY_IDX = 16;
  const TZ_IDX = 31;
  const LOC_TYPE_IDX = 41;

  const byCode = new Map();
  const countriesByCode = new Map();

  for (const line of dataLines) {
    if (!line || !line.trim()) {
      continue;
    }
    const fields = line.split('^');
    const iataCode = (fields[IATA_IDX] || '').trim();
    if (!iataCode) {
      continue;
    }
    // A non-empty envelope_id marks an expired/historical record (e.g. an
    // IATA code's previous assignment). Without this filter ~300 expired
    // rows leak in, and for reassigned codes the DEAD assignment can win
    // over the live one (JSO would emit Södertälje/SE instead of the
    // current Sobral/BR).
    if ((fields[ENVELOPE_IDX] || '').trim() !== '') {
      continue;
    }

    const countryId = (fields[COUNTRY_IDX] || '').trim();
    if (countryId) {
      if (!countriesByCode.has(iataCode)) {
        countriesByCode.set(iataCode, new Set());
      }
      countriesByCode.get(iataCode).add(countryId);
    }

    const locationType = (fields[LOC_TYPE_IDX] || '').trim();
    if (!locationType.includes('C')) {
      continue;
    }

    const entry = {
      code: iataCode,
      time_zone_id: fields[TZ_IDX] || '',
      name: fields[NAME_IDX] || '',
      city_code: iataCode,
      country_id: fields[COUNTRY_IDX] || '',
      location: `POINT (${fields[LON_IDX] || ''} ${fields[LAT_IDX] || ''})`,
      elevation: '',
      url: '',
      icao: '',
      city: fields[NAME_IDX] || '',
      county: '',
      state: '',
    };

    const existing = byCode.get(iataCode);
    if (!existing) {
      byCode.set(iataCode, { entry, exactC: locationType === 'C' });
    } else if (!existing.exactC && locationType === 'C') {
      // Prefer the row whose location_type is exactly "C" over "CA"/"CR"/etc.
      byCode.set(iataCode, { entry, exactC: true });
    }
    // otherwise: first seen wins, keep existing.
  }

  const cities = Array.from(byCode.values()).map((v) => v.entry);

  // getCountryFromIATACode() falls back to a city's `country_id` for the ~1,000 codes that are
  // cities without an airport entry, and consumers resolve that value through
  // country-code-lookup's byIso(). Fail the run if any of them would not resolve.
  const unresolvable = [...new Set(cities.map((c) => c.country_id))].filter(
    (iso) => !iso || iso.length !== 2 || !countryCodeLookup.byIso(iso)
  );
  if (unresolvable.length) {
    throw new Error(
      `city country_id values not resolvable via country-code-lookup.byIso(): ${unresolvable.join(', ')}`
    );
  }

  fs.writeFileSync(CITIES_JSON_PATH, JSON.stringify(cities));
  return { cities, countriesByCode };
}

async function main() {
  download(AIRPORTS_CSV_URL, AIRPORTS_CSV_PATH);
  download(OTD_POR_URL, OTD_POR_PATH);

  // Cities first: the airport carry-forward checks a retired code's country against
  // OpenTravelData's current records (see carryForwardRetired).
  const { cities, countriesByCode } = buildCities();
  const airports = await buildAirports(countriesByCode);

  console.log(
    `Wrote ${AIRPORTS_JSON_PATH} (${airports.length} entries, ${airports.filter((a) => a.retired).length} retired)`
  );
  console.log(`Wrote ${CITIES_JSON_PATH} (${cities.length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
