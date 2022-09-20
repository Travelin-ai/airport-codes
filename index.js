const airports = require('./airports.json');

const getAirportFromIATACode = (iataCode) => {
  return airports.find((s) => s.iata === iataCode) || null;
};

const getCityFromIATACode = (iataCode) => {
  const airport = getAirportFromIATACode(iataCode);
  if (airport) {
    return airport.city;
  }
  return null;
}

const getCountryFromIATACode = (iataCode) => {
  const airport = getAirportFromIATACode(iataCode);
  if (airport)
    return airport.country;
  return null;
}

module.exports = {
  getAirportFromIATACode,
  getCityFromIATACode,
  getCountryFromIATACode,
};