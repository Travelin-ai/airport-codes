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
 * Committed inputs read by every run: airports.csv (the OurAirports snapshot), overrides.json
 * (manual corrections and the exclusion list) and retired.json (codes OurAirports no longer
 * carries). airports.json and cities.json are outputs only; the build never reads them back.
 *
 * Usage: npm run generate               (or: node generate.js)
 *        npm run generate -- --offline   rebuild from the files already on disk, no downloads
 *
 * See README.md for details, including how overrides.json and retired.json are applied.
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
const OFFLINE = process.argv.includes('--offline');

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
const RETIRED_JSON_PATH = path.join(REPO_DIR, 'retired.json');

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

function byIata(a, b) {
  if (a.iata < b.iata) return -1;
  if (a.iata > b.iata) return 1;
  return 0;
}

// Retired codes: a booking made while a code was current keeps that code for life (a PBI booked
// in July still says PBI after IATA reassigned it to DJT on 2026-08-18), and the consuming
// services look the airport up by that code for as long as the booking exists — trip type,
// city names in emails, timezone maths, policy country rules. Upstream drops a code the day it
// is retired, so retired.json keeps every entry OurAirports no longer carries and the build
// appends them to airports.json marked `retired: true`. The memory of what was current last run
// is the committed airports.csv snapshot, read before the download overwrites it: the codes it
// has that the fresh file lacks are this run's retirements, and they are added to retired.json —
// one entry per line, so the file's diff is what a reviewer reads. Upstream always wins for a
// code it carries again, and OpenTravelData is consulted for the same reason: a code it now lists
// under another country was reassigned, and the retired entry is that code's dead meaning, so it
// is removed rather than resolve to the wrong country.
function loadRetired() {
  // The carry-forward is only as good as this file. A missing one would silently regenerate
  // without any retired code, so fail instead of shipping that.
  if (!fs.existsSync(RETIRED_JSON_PATH)) {
    throw new Error(
      `${RETIRED_JSON_PATH} is missing; it holds the retired IATA codes. Restore it (git checkout -- retired.json) before regenerating.`
    );
  }
  const retired = JSON.parse(fs.readFileSync(RETIRED_JSON_PATH, 'utf8'));
  if (!Array.isArray(retired)) {
    throw new Error(`${RETIRED_JSON_PATH} must be a JSON array of airport entries.`);
  }
  return retired;
}

const RETIRED_FIELDS = ['iata', 'name', 'city', 'country', 'icao', 'latitude', 'longitude'];

// One entry per line, sorted by code, so a pull request diff reads as "these codes were retired
// (or removed) by this run".
function writeRetired(retired) {
  const lines = retired
    .slice()
    .sort(byIata)
    .map((a) => JSON.stringify(Object.fromEntries(RETIRED_FIELDS.map((key) => [key, String(a[key] ?? '')]))));
  fs.writeFileSync(RETIRED_JSON_PATH, `[\n${lines.join(',\n')}\n]\n`);
}

// `retired` is retired.json; `previous` the entries the committed airports.csv produced before
// this run downloaded over it; `current` this run's entries after overrides; `excluded` the
// codes overrides.json drops. `otdCountriesByCode` maps each IATA code to the ISO-2 countries of
// its current OpenTravelData records (see buildCities).
function reconcileRetired({ retired, previous, current, excluded, otdCountriesByCode }) {
  const currentCodes = new Set(current.map((a) => a.iata));
  const retiredCodes = new Set();
  const kept = [];
  const newlyRetired = [];
  const currentAgain = [];
  const removed = [];
  const dropped = [];

  const consider = (entry, isNew) => {
    const iata = String(entry.iata || '').trim().toUpperCase();
    if (!iata) {
      console.warn('WARNING: skipping retired entry with no "iata" field:', entry);
      return;
    }
    if (excluded.has(iata)) {
      dropped.push(iata);
      return;
    }
    // Upstream carries the code again, so its current entry replaces the retired one.
    if (currentCodes.has(iata)) {
      currentAgain.push(iata);
      return;
    }
    const country = String(entry.country || '');
    // Reassigned code: OpenTravelData lists it today under another country (OEL: the retired
    // entry says Oryol Yuzhny Airport, United States; today OEL is Orël, RU. BAU: the retired
    // entry says Bauru Airport, Brazil; today BAU is Bari Centrale Railway Station, IT). Keeping
    // the old entry would resolve the code to a wrong country with no warning — upstream wins.
    const otdCountries = otdCountriesByCode.get(iata);
    const countryIso = countryCodeLookup.byCountry(country)?.iso2;
    if (otdCountries && countryIso && !otdCountries.has(countryIso)) {
      removed.push(`${iata} (reassigned: ${country} → ${[...otdCountries].join('/')})`);
      return;
    }
    // Upstream's own duplicate markers are data-quality removals, not retirements.
    if (/^\[Duplicate\]/i.test(String(entry.name || ''))) {
      removed.push(`${iata} (${entry.name})`);
      return;
    }
    kept.push({ ...entry, iata, country });
    if (isNew) {
      newlyRetired.push(iata);
    }
  };

  for (const entry of retired) {
    const iata = String((entry && entry.iata) || '').trim().toUpperCase();
    // The lookups are find()-based, so a duplicate would resolve arbitrarily.
    if (iata && retiredCodes.has(iata)) {
      throw new Error(`${RETIRED_JSON_PATH} lists ${iata} twice; keep one entry per code.`);
    }
    retiredCodes.add(iata);
    consider(entry, false);
  }
  for (const entry of previous) {
    if (!currentCodes.has(entry.iata) && !retiredCodes.has(entry.iata)) {
      consider(entry, true);
    }
  }
  return { retired: kept, newlyRetired, currentAgain, removed, dropped };
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

// Manual corrections (see overrides.json / README.md), applied before sorting and assigning
// ids so overridden and new entries participate in both. `drop: true` is the exclusion list:
// the code leaves airports.json — the current data here, retired.json in reconcileRetired —
// and never re-enters retired.json.
function applyOverrides(airports) {
  const excluded = new Set();
  for (const override of loadOverrides()) {
    if (!override || !override.iata) {
      console.warn('WARNING: skipping override entry with no "iata" field:', override);
      continue;
    }
    if (override.drop) {
      excluded.add(String(override.iata).trim().toUpperCase());
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
  const dropped = airports.filter((a) => excluded.has(a.iata)).map((a) => a.iata);
  return { airports: airports.filter((a) => !excluded.has(a.iata)), excluded, dropped };
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

// The current entries an OurAirports snapshot produces, one per IATA code. `quiet` silences the
// duplicate warnings for the pass over last run's snapshot, which already printed them then.
async function airportsFromCsv(csvPath, { quiet = false } = {}) {
  const rows = await CSVToJSON().fromFile(csvPath);

  const byIataCode = new Map();
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

    const existing = byIataCode.get(iata);
    if (existing) {
      if (!quiet) {
        console.warn(`WARNING: duplicate iata_code "${iata}" in source data - keeping one row.`);
      }
      byIataCode.set(iata, preferRow(existing, row));
    } else {
      byIataCode.set(iata, row);
    }
  }

  const airports = [];
  for (const row of byIataCode.values()) {
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
  return airports;
}

async function buildAirports({ previous, otdCountriesByCode }) {
  const fresh = await airportsFromCsv(AIRPORTS_CSV_PATH);
  const { airports: current, excluded, dropped: droppedCurrent } = applyOverrides(fresh);

  const reconciled = reconcileRetired({
    retired: loadRetired(),
    previous,
    current,
    excluded,
    otdCountriesByCode,
  });
  const { retired, newlyRetired, currentAgain, removed } = reconciled;
  const dropped = [...new Set([...droppedCurrent, ...reconciled.dropped])];

  // Review gate: junk upstream removes (placeholder codes, test rows) would otherwise become
  // permanent entries without anyone noticing — the retired.json diff shows exactly these.
  console.log(
    `Newly retired this run (added to retired.json; review its diff before committing): ${newlyRetired.join(', ') || 'none'}`
  );
  if (currentAgain.length) {
    console.log(`Current again (removed from retired.json): ${currentAgain.join(', ')}`);
  }
  if (removed.length) {
    console.log(`Not carried forward (removed from retired.json): ${removed.join('; ')}`);
  }
  if (dropped.length) {
    console.log(`Dropped by overrides.json: ${dropped.join(', ')}`);
  }
  writeRetired(retired);
  console.log(`Carried forward ${retired.length} retired IATA codes from ${RETIRED_JSON_PATH}`);

  let airports = [...current, ...retired.map((a) => ({ ...a, retired: true }))];
  airports.sort(byIata);

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
// OpenTravelData record, keyed by IATA code, for the reassignment check in reconcileRetired.
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
  // What was current last run, read before the download overwrites the snapshot (see
  // reconcileRetired). Without it no retirement can be detected, so fail rather than
  // regenerate as if nothing had been retired.
  if (!fs.existsSync(AIRPORTS_CSV_PATH)) {
    throw new Error(
      `${AIRPORTS_CSV_PATH} is missing; the retired-code detection compares it with the fresh download. Restore it (git checkout -- airports.csv) before regenerating.`
    );
  }
  const previous = await airportsFromCsv(AIRPORTS_CSV_PATH, { quiet: true });

  if (OFFLINE) {
    if (!fs.existsSync(OTD_POR_PATH)) {
      throw new Error(
        `--offline needs ${OTD_POR_PATH} from an earlier run; run once without --offline to download it.`
      );
    }
    console.log(`Offline: rebuilding from ${AIRPORTS_CSV_PATH} and ${OTD_POR_PATH}, nothing downloaded.`);
  } else {
    download(AIRPORTS_CSV_URL, AIRPORTS_CSV_PATH);
    download(OTD_POR_URL, OTD_POR_PATH);
  }

  // Cities first: the retired-code reconciliation checks each code's country against
  // OpenTravelData's current records (see reconcileRetired).
  const { cities, countriesByCode } = buildCities();
  const airports = await buildAirports({ previous, otdCountriesByCode: countriesByCode });

  console.log(
    `Wrote ${AIRPORTS_JSON_PATH} (${airports.length} entries, ${airports.filter((a) => a.retired).length} retired)`
  );
  console.log(`Wrote ${CITIES_JSON_PATH} (${cities.length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
