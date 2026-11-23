'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const countryCodeLookup = require('country-code-lookup');

const {
  buildAirports,
  airportsFromCsv,
  reconcileRetired,
  formatRetired,
  AIRPORTS_CSV_PATH,
  AIRPORTS_JSON_PATH,
  RETIRED_JSON_PATH,
  CITIES_JSON_PATH,
} = require('../generate');
const { getAirportFromIATACode, getCityFromIATACode, getCountryFromIATACode } = require('../index');

const airports = require('../airports.json');
const cities = JSON.parse(fs.readFileSync(CITIES_JSON_PATH, 'utf8'));
const retired = require('../retired.json');
const overrides = require('../overrides.json');

// airports.json can be rebuilt here from the committed inputs. retired.json is already the
// post-reconciliation list, so an empty OpenTravelData map (which only skips the reassignment
// check) reproduces it. cities.json cannot be rebuilt: its source, optd_por_public.csv, lives
// in the OS temp dir and is never committed, so cities.json only gets invariant checks.

const AIRPORT_KEYS = ['id', 'name', 'city', 'country', 'iata', 'icao', 'latitude', 'longitude'];
const CITY_KEYS = [
  'code',
  'time_zone_id',
  'name',
  'city_code',
  'country_id',
  'location',
  'elevation',
  'url',
  'icao',
  'city',
  'county',
  'state',
];

test('airports.json is what generate.js builds from the committed inputs', async () => {
  const previous = await airportsFromCsv(AIRPORTS_CSV_PATH, { quiet: true });
  const built = await buildAirports({
    previous,
    freshCsvPath: AIRPORTS_CSV_PATH,
    otdCountriesByCode: new Map(),
  });
  assert.equal(
    JSON.stringify(built.airports),
    fs.readFileSync(AIRPORTS_JSON_PATH, 'utf8'),
    'airports.json was edited by hand; put the change in overrides.json or retired.json and run npm run generate'
  );
});

test('retired.json is in the form a run writes it', () => {
  assert.equal(
    formatRetired(retired),
    fs.readFileSync(RETIRED_JSON_PATH, 'utf8'),
    'retired.json is not in generated form; run npm run generate'
  );
});

test('airport entries have the expected shape', () => {
  assert.ok(airports.length > 0);
  airports.forEach((a, i) => {
    const expectedKeys = a.retired === undefined ? AIRPORT_KEYS : [...AIRPORT_KEYS, 'retired'];
    assert.deepEqual(Object.keys(a), expectedKeys, `entry ${a.iata} has the wrong keys`);
    for (const key of AIRPORT_KEYS) {
      assert.equal(typeof a[key], 'string', `${a.iata}.${key} must be a string`);
    }
    if (a.retired !== undefined) {
      assert.equal(a.retired, true, `${a.iata}.retired must be true when present`);
    }
    assert.match(a.iata, /^[A-Z0-9]{3}$/);
    assert.equal(a.id, String(i + 1), `${a.iata} has an out-of-sequence id`);
  });
});

test('airport iata codes are unique and sorted', () => {
  const codes = airports.map((a) => a.iata);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(codes, codes.slice().sort());
});

test('retired flags match retired.json', () => {
  const flagged = airports.filter((a) => a.retired === true).map((a) => a.iata).sort();
  const listed = retired.map((a) => a.iata).sort();
  assert.deepEqual(flagged, listed);
});

test('dropped codes are not in airports.json', () => {
  const codes = new Set(airports.map((a) => a.iata));
  for (const o of overrides.filter((entry) => entry.drop === true)) {
    assert.ok(!codes.has(o.iata), `${o.iata} is dropped by overrides.json but is in airports.json`);
  }
});

test('every airport country resolves through country-code-lookup', () => {
  for (const country of new Set(airports.map((a) => a.country))) {
    assert.ok(countryCodeLookup.byCountry(country), `"${country}" does not resolve via byCountry()`);
  }
});

test('country-code-lookup is the pinned version', () => {
  assert.equal(require('country-code-lookup/package.json').version, '0.0.22');
});

test('city entries have the expected shape', () => {
  assert.ok(cities.length > 0);
  for (const c of cities) {
    assert.deepEqual(Object.keys(c), CITY_KEYS, `city ${c.code} has the wrong keys`);
    for (const key of CITY_KEYS) {
      assert.equal(typeof c[key], 'string', `${c.code}.${key} must be a string`);
    }
    assert.match(c.code, /^[A-Z0-9]{3}$/);
  }
  const codes = cities.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
});

test('every city country_id resolves through country-code-lookup', () => {
  for (const iso of new Set(cities.map((c) => c.country_id))) {
    assert.ok(countryCodeLookup.byIso(iso), `"${iso}" does not resolve via byIso()`);
  }
});

test('lookups find airports, city-only codes and retired codes', () => {
  assert.equal(getAirportFromIATACode('JFK').name, 'John F. Kennedy International Airport');
  assert.equal(getCityFromIATACode('JFK'), 'New York');
  assert.equal(getCountryFromIATACode('JFK'), 'United States');

  assert.equal(getCityFromIATACode('LON'), 'London');
  assert.equal(getCountryFromIATACode('LON'), 'GB');

  const gone = retired[0];
  const found = getAirportFromIATACode(gone.iata);
  assert.equal(found.name, gone.name);
  assert.equal(found.retired, true);
});

test('lookups return null for unknown or empty codes', () => {
  for (const code of ['ZZZ', '', undefined, null]) {
    assert.equal(getAirportFromIATACode(code), null);
    assert.equal(getCityFromIATACode(code), null);
    assert.equal(getCountryFromIATACode(code), null);
  }
});

test('reconcileRetired applies each rule', () => {
  const entry = (iata, extra = {}) => ({ iata, name: `${iata} Airport`, country: 'Italy', ...extra });
  const result = reconcileRetired({
    retired: [
      entry('AGN'), // current again
      entry('EXC'), // excluded
      entry('BAU', { country: 'Brazil' }), // reassigned to Italy
      entry('DUP', { name: '[Duplicate] Somewhere' }),
      entry('OLD'), // stays retired
    ],
    previous: [entry('NEW')], // in the last snapshot, gone now
    current: [entry('AGN')],
    excluded: new Set(['EXC']),
    otdCountriesByCode: new Map([['BAU', new Set(['IT'])]]),
  });

  assert.deepEqual(result.currentAgain, ['AGN']);
  assert.deepEqual(result.dropped, ['EXC']);
  assert.equal(result.removed.length, 2);
  assert.ok(result.removed[0].startsWith('BAU (reassigned'));
  assert.ok(result.removed[1].startsWith('DUP'));
  assert.deepEqual(result.newlyRetired, ['NEW']);
  assert.deepEqual(result.retired.map((a) => a.iata), ['OLD', 'NEW']);
});
