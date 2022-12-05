// require csvtojson module
const CSVToJSON = require("csvtojson");
const countries = require("i18n-iso-countries");
const fs = require("fs");

countries.registerLocale(require("i18n-iso-countries/langs/en.json"));

const airports1 = require("./airports.json");

const reduce = (arr1, arr2,prop) => {
    return arr1.map((obj) => {
      const numbers = arr2.filter((nums) => nums[prop] === obj[prop]);
      if (!numbers.length) {
        return obj;
      }
    }).filter(x=>x);
};


let count = 14110;

const csvtojson = () => {
    try {
        CSVToJSON()
            .fromFile(`airports.csv`)
            .then(data => {
                const Jsondata = [];

                for (let i = 0; i < data.length; i++) {
                    if (data[i].iata_code.trim() !== '') {
                        count = count + 1;
                        Jsondata.push({
                            id: `${count}`,
                            name: data[i].name,
                            icao: data[i].ident,
                            country: countries.getName(`${data[i].iso_country}`, "en"),
                            city: data[i].municipality,
                            iata: data[i]['iata_code'],
                            latitude: data[i].latitude_deg,
                            longitude: data[i].longitude_deg,
                        });
                    }
                }

                const airports1Filtered = airports1.filter(x => (x['iata'] != "\\N" || x['iata'].trim() != ''));

                const reducedArr = reduce(Jsondata,airports1,"iata");
                const mergeWithExisting = airports1Filtered.concat(reducedArr)

                fs.writeFileSync(`airports.json`, JSON.stringify(mergeWithExisting))
            })
            .catch((err) => {
                console.log(err);
            });
    } catch (err) {
        console.log(err);
        process.exit(1);
    }
};

module.exports = { csvtojson }

