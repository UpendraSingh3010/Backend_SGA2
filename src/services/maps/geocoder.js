/**
 * Geocoder facade. Routes always call `geocoder.geocode(...)` through this
 * object, so tests can replace the behaviour with sinon.stub(geocoder, 'geocode').
 */
const config = require('../../config');
const nominatim = require('./providers/nominatim');
const mock = require('./providers/mock');

const providers = { nominatim, mock };

const geocoder = {
  providerName() {
    return providers[config.geo.provider] ? config.geo.provider : 'nominatim';
  },
  provider() {
    return providers[this.providerName()];
  },
  /** @returns {Promise<{lat:number,lng:number,displayName:string,provider:string}|null>} */
  geocode(address) {
    return this.provider().geocode(address);
  },
  reverse(lat, lng) {
    return this.provider().reverse(lat, lng);
  },
};

module.exports = geocoder;
