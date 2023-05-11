const csv = require('csv');
const JSONStream = require('JSONStream');
const fs = require('fs');
const _ = require('lodash');
const columns = ['code', 'time_zone_id', 'name', 'city_code', 'country_id', 'location', 'elevation', 'url', 'icao', 'city', 'county', 'state'];

const readStream = fs.createReadStream('citycodes.csv');
const writeStream = fs.createWriteStream('cities.json');

const transformer = csv.transform(function(data) {
  return _.zipObject(columns, data);
});

readStream
  .pipe(csv.parse())
  .pipe(transformer)
  .pipe(JSONStream.stringify())
  .pipe(writeStream);
//  .on('finish', function (err) {
//     csvtojson()
//  });
