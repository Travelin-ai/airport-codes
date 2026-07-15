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
const { execSync } = require('child_process');
const CSVToJSON = require('csvtojson');
const countries = require('i18n-iso-countries');

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

// i18n-iso-countries returns some official/long-form names that don't match
// common usage. Override those here. Add more entries if getName() ever
// returns undefined for a code encountered in the data (a warning will be
// logged for those).
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
  FM: 'Micronesia',
  MK: 'North Macedonia',
  VG: 'British Virgin Islands',
  VI: 'U.S. Virgin Islands',
  FK: 'Falkland Islands',
  BN: 'Brunei',
  GM: 'Gambia',
  PS: 'Palestine',
  SX: 'Sint Maarten',
};

function download(url, dest) {
  console.log(`Downloading ${url}\n  -> ${dest}`);
  // -f makes curl exit non-zero on HTTP errors (so execSync throws) instead of
  // silently saving an error page; --retry handles transient network failures.
  execSync(`curl -fsSL --retry 3 -o ${JSON.stringify(dest)} ${JSON.stringify(url)}`, {
    stdio: 'inherit',
  });
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

async function buildAirports() {
  const rows = await CSVToJSON().fromFile(AIRPORTS_CSV_PATH);

  let airports = [];
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
      city: row.municipality,
      country: getCountryName(row.iso_country),
      iata,
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

  airports.sort((a, b) => {
    if (a.iata < b.iata) return -1;
    if (a.iata > b.iata) return 1;
    return 0;
  });

  airports = airports.map((a, i) => ({
    id: String(i + 1),
    name: String(a.name),
    city: String(a.city),
    country: String(a.country),
    iata: String(a.iata),
    icao: String(a.icao),
    latitude: String(a.latitude),
    longitude: String(a.longitude),
  }));

  fs.writeFileSync(AIRPORTS_JSON_PATH, JSON.stringify(airports));
  return airports;
}

function buildCities() {
  const raw = fs.readFileSync(OTD_POR_PATH, 'utf8');
  const lines = raw.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  // Drop the header row - it must not be emitted as a data entry.
  const dataLines = lines.slice(1);

  // 0-based column indices in optd_por_public.csv (51 caret-separated columns).
  const IATA_IDX = 0;
  const NAME_IDX = 6;
  const LAT_IDX = 8;
  const LON_IDX = 9;
  const COUNTRY_IDX = 16;
  const TZ_IDX = 31;
  const LOC_TYPE_IDX = 41;

  const byCode = new Map();

  for (const line of dataLines) {
    if (!line) {
      continue;
    }
    const fields = line.split('^');
    const iataCode = (fields[IATA_IDX] || '').trim();
    const locationType = (fields[LOC_TYPE_IDX] || '').trim();
    if (!iataCode || !locationType.includes('C')) {
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
  fs.writeFileSync(CITIES_JSON_PATH, JSON.stringify(cities));
  return cities;
}

async function main() {
  download(AIRPORTS_CSV_URL, AIRPORTS_CSV_PATH);
  download(OTD_POR_URL, OTD_POR_PATH);

  const airports = await buildAirports();
  const cities = buildCities();

  console.log(`Wrote ${AIRPORTS_JSON_PATH} (${airports.length} entries)`);
  console.log(`Wrote ${CITIES_JSON_PATH} (${cities.length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
