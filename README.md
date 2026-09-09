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
So `npm run generate` never removes a code from `airports.json`: every entry of the previously
committed file that the fresh build no longer produces is carried forward, marked
`retired: true` (the lookups ignore the flag; it is there for anything that must not offer a
retired code to users). Two exceptions, both logged as "Not carried forward":

- Upstream always wins. A code OurAirports still carries resolves to its current airport, and a
  code OpenTravelData now lists under another country was reassigned, so its previous entry is
  dropped rather than resolve to the wrong country.
- Entries OurAirports marked `[Duplicate]` were data-quality removals, not retirements.

Retired entries are permanent otherwise, so each run prints the codes newly retired by that run;
review them before committing (upstream removes the odd placeholder or test row too). Deleting an
entry by hand from `airports.json` before regenerating is the way to drop one. `cities.json` has
no carry-forward: it is rebuilt from OpenTravelData, whose expired records are already filtered
out, and its `country_id` values are asserted to resolve through `country-code-lookup`'s
`byIso()` because `getCountryFromIATACode()` falls back to them for city-only codes.

The 2026-09-09 regeneration seeded this carry-forward once with the pre-July `airports.json`
(commit `1aeb4c1`). The July full rebuild had silently dropped 256 codes; 4 of them upstream had
re-added by September, the rest came back as retired entries.

## Thanks

- [Ram Nadella](https://github.com/ram-nadella/airport-codes)
- [OurAirports](https://ourairports.com/) / [David Megginson](https://github.com/davidmegginson)
- [OpenTravelData](https://github.com/opentraveldata/opentraveldata)
