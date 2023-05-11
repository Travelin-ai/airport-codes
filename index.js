const airports = require('./airports.json');
const cities = require('./cities.json');

const getCityFromIATACityCode = (cityCode) => {
  return cities.find((s) => s.code === cityCode) || null;
};

const getAirportFromIATACode = (iataCode) => {
  return airports.find((s) => s.iata === iataCode) || null;
};

const getCityFromIATACode = (iataCode) => {
  const airport = getAirportFromIATACode(iataCode);
  if (airport) {
    return airport.city;
  }
  const city = getCityFromIATACityCode(iataCode);
  if (city) {
    return city.city;
  }
  return null;
}

/**
 * @param {string} iataCode
 * @returns {string} Country
*/
const getCountryFromIATACode = (iataCode) => {
  const airport = getAirportFromIATACode(iataCode);
  if (airport) {
    return airport.country;
  }
  const city = getCityFromIATACityCode(iataCode);
  if (city) {
    return city.country_id;
  }
  return null;
}

module.exports = {
  getAirportFromIATACode,
  getCityFromIATACode,
  getCountryFromIATACode,
};
