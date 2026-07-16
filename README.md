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

## Thanks

- [Ram Nadella](https://github.com/ram-nadella/airport-codes)
- [OurAirports](https://ourairports.com/) / [David Megginson](https://github.com/davidmegginson)
- [OpenTravelData](https://github.com/opentraveldata/opentraveldata)
