# Airport Codes
> Airport codes (IATA) and information pulled from OurAirports and OpenTravelData

## Install

```
npm install airport-codes
```

## Usage

The package exports three lookup functions:

```javascript
const {
  getAirportFromIATACode,
  getCityFromIATACode,
  getCountryFromIATACode,
} = require('airport-codes');

getAirportFromIATACode('JFK');
// => { id: '...', name: 'John F. Kennedy International Airport', city: 'New York',
//      country: 'United States', iata: 'JFK', icao: 'KJFK',
//      latitude: '40.639447', longitude: '-73.779317' }
// Returns null if the code is unknown.

getCityFromIATACode('JFK');    // => 'New York'
getCityFromIATACode('LON');    // => 'London' (city/metro-area codes work too)
getCountryFromIATACode('JFK'); // => 'United States'
```

Most entries carry a real ICAO code in `icao`, but a couple hundred small airfields that
don't have one fall back to the OurAirports identifier (e.g. `BR-2149`), so don't assume
`icao` is always a valid ICAO code.

If you'd like only the raw JSON data, import it directly:

```javascript
const airports = require('airport-codes/airports.json');
const cities = require('airport-codes/cities.json');
```

## Update the list of Airport Codes

`airports.json` and `cities.json` are generated from fresh upstream data by a single script:

```
npm run generate
```

This downloads the source files itself (no manual `wget` steps needed) and regenerates both
JSON files in place. It pulls from two sources:

- **[OurAirports](https://davidmegginson.github.io/ourairports-data/airports.csv)** (maintained
  by David Megginson) - used to build `airports.json`. The downloaded CSV overwrites the
  `airports.csv` snapshot committed in this repo, so upstream changes show up in the diff.
- **[OpenTravelData](https://raw.githubusercontent.com/opentraveldata/opentraveldata/master/opentraveldata/optd_por_public.csv)**
  `optd_por_public.csv` - used to build `cities.json` (city/metro-area codes). This file is
  large (about 13 MB) and is downloaded to a temp directory outside the repo; it is never
  committed.

Two more inputs are committed and read by every run: `overrides.json` (manual corrections and
the exclusion list) and `retired.json` (codes OurAirports no longer carries), both described
below. `airports.json` and `cities.json` are outputs only; the build never reads them back, so
they can always be rebuilt from the committed inputs plus the two downloads. A run builds and
validates everything in memory first and only then writes the three outputs and the new
`airports.csv` snapshot, each via a temp file and rename, so a failed or interrupted run leaves
the committed files as they were.

`npm run generate -- --offline` rebuilds from the files already on disk (the committed
`airports.csv` and the OpenTravelData file an earlier run left in the temp directory) without
downloading anything. Use it to check that a change to the script or to the committed inputs
reproduces `airports.json` exactly, or to rebuild after editing `overrides.json` or
`retired.json` by hand.

### Manual corrections

`overrides.json` lets you patch individual airport entries without hand-editing
`airports.json` (which gets fully regenerated on every run). Each element is a partial airport
object that must include `iata`; any other keys you provide (`name`, `city`, `country`, `icao`,
`latitude`, `longitude`) are merged over the matching entry. If no airport with that `iata` code
exists, the override is appended as a new entry. Overrides are applied every time
`npm run generate` runs.

Example - correct a city name for `JFK`:

```json
[
  { "iata": "JFK", "city": "New York City" }
]
```

An entry with `"drop": true` is the exclusion list: the code leaves `airports.json`, from the
current OurAirports data and from `retired.json` alike, and the build never adds it to
`retired.json` again. Use it for placeholder or test rows that should stay out for good. A
`"reason"` key is ignored by the build and welcome for the reviewer. Dropping only affects
`airports.json`; `cities.json` is built from OpenTravelData as is.

```json
[
  { "iata": "SZT", "drop": true, "reason": "San Cristóbal de las Casas airport closed in 2010" }
]
```

One constraint on `country` values: every `country` emitted into `airports.json` - including
any set via `overrides.json` - must resolve through the `country-code-lookup` library's
`byCountry()`, so use that library's exact `country` strings. `npm run generate` asserts this
after building and fails the run if a name doesn't resolve. The `country-code-lookup`
devDependency is pinned exactly (`0.0.22`) because consumers feed `getCountryFromIATACode()`
output back through that library, and newer releases rename countries (e.g. Turkey → Türkiye);
bump the pin only in lockstep with the consuming services.

### Retired codes

IATA occasionally retires or reassigns a code (Palm Beach's PBI became DJT on 2026-08-18), and
OurAirports drops the old code the same day. Bookings made while a code was current keep it for
life, and the consuming services look airports up by that code for as long as the booking exists.
So `npm run generate` never removes a code from `airports.json`: `retired.json` holds every entry
OurAirports no longer carries, and the build appends them to `airports.json` marked
`retired: true` (the lookups ignore the flag; it is there for anything that must not offer a
retired code to users).

Each run compares the committed `airports.csv` snapshot (what was current last run) with the
fresh download and adds the codes that disappeared to `retired.json`, one entry per line, so the
file's diff in a pull request is the list of codes retired by that run. Review it before committing:
upstream removes the odd placeholder or test row too, and those should not become permanent
entries. To keep one out, delete its line from `retired.json` (it only comes back if OurAirports
lists the code again and later drops it again) or, to keep it out for good, add it to
`overrides.json` with `"drop": true`. A run that would retire more than 1% of last run's codes
stops without writing anything, because that is what a truncated download or a renamed upstream
column looks like; pass `--allow-mass-retirement` when the retirements are real. A malformed
`retired.json` entry (no valid `iata`, or a code listed twice) also stops the run rather than
being dropped by the rewrite.

Two kinds of entry are removed from `retired.json` instead, and logged:

- Upstream always wins. A code OurAirports carries again resolves to its current airport
  ("Current again"), and a code OpenTravelData now lists under another country was reassigned, so
  its retired entry is dropped rather than resolve to the wrong country ("Not carried forward").
  That check reads every current OpenTravelData record, not only cities: a code reassigned to a
  railway or bus station (BAU, once Bauru Airport in Brazil, is now Bari Centrale Railway
  Station) has no city record.
- Entries OurAirports marked `[Duplicate]` were data-quality removals, not retirements.

In practice `retired` means "OurAirports no longer lists this code", not "IATA retired this code":
most entries are still current codes in OpenTravelData under the same country (many are railway
and bus stations OurAirports never carried), some exist there only as expired records, and a few
are in neither source.

`cities.json` has no carry-forward: it is rebuilt from OpenTravelData, whose expired records are
already filtered out, and its `country_id` values are asserted to resolve through
`country-code-lookup`'s `byIso()` because `getCountryFromIATACode()` falls back to them for
city-only codes.

`retired.json` was seeded on 2026-09-09 from the pre-July `airports.json` (commit `1aeb4c1`): the
July full rebuild had silently dropped 256 codes; 4 of them upstream had re-added by September,
the rest came back as retired entries, and the two rules above then removed 22 of those. The
file starts with the 236 that remained.

## Thanks

- [Ram Nadella](https://github.com/ram-nadella/airport-codes)
- [OurAirports](https://ourairports.com/) / [David Megginson](https://github.com/davidmegginson)
- [OpenTravelData](https://github.com/opentraveldata/opentraveldata)
