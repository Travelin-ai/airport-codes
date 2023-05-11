const csv = require('csv');
const JSONStream = require('JSONStream');
const fs = require('fs');
const _ = require('lodash');
const { csvtojson } = require('./newConvert')
// const columns = ['id', 'name', 'city', 'country', 'iata', 'icao', 'latitude', 'longitude', 'altitude', 'timezone', 'dst', 'tz'];
const columns = ['id', 'name', 'city', 'country', 'iata', 'icao', 'latitude', 'longitude'];

const readStream = fs.createReadStream('airports.dat');
const writeStream = fs.createWriteStream('airports.json');

const transformer = csv.transform(function(data) {
  return _.zipObject(columns, data);
});

readStream
  .pipe(csv.parse())
  .pipe(transformer)
  .pipe(JSONStream.stringify())
  .pipe(writeStream)
  .on('finish', function (err) {
     csvtojson()
  });
