# Airport Codes
> Airport codes (IATA) and information pulled from OpenFlights.org

## Install

```
npm install airport-codes
```

## Usage

If you'd like only the JSON list of airport codes, you can use either the Backbone Collection's `toJSON` method or import the json list directly:

```javascript
require('airport-codes').toJSON();
require('airport-codes/airports.json');
```

## Update the list of Airport Codes

### Fetch Airport codes

```
$ wget https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat
```

TODO: merge with `https://davidmegginson.github.io/ourairports-data/airports.csv`
TODO2: merge with `https://raw.githubusercontent.com/lxndrblz/Airports/main/airports.csv`

### Fetch City codes

```
$ wget https://raw.githubusercontent.com/lxndrblz/Airports/main/citycodes.csv
```


### Generate the list

Convert the list of airport codes from csv format to JSON.

```
node convert.js
node convertCities.js
```

## Thanks

- [Ram Nadella](https://github.com/ram-nadella/airport-codes)
- [Jani Patokallio](https://github.com/jpatokal/openflights/)
