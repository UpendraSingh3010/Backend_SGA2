/**
 * Service registry - where each backend service lives.
 * The gateway and services resolve URLs through here at call time, which lets
 * tests start services on random ports and register them.
 */
const config = require('../config');

const urls = {
  users: process.env.USER_SERVICE_URL || `http://127.0.0.1:${config.ports.users}`,
  vehicles: process.env.VEHICLE_SERVICE_URL || `http://127.0.0.1:${config.ports.vehicles}`,
  telemetry: process.env.TELEMETRY_SERVICE_URL || `http://127.0.0.1:${config.ports.telemetry}`,
  maps: process.env.MAPS_SERVICE_URL || `http://127.0.0.1:${config.ports.maps}`,
  notifications:
    process.env.NOTIFICATION_SERVICE_URL || `http://127.0.0.1:${config.ports.notifications}`,
};

module.exports = {
  names: () => Object.keys(urls),
  get: (name) => urls[name],
  set: (name, url) => {
    urls[name] = url;
  },
  all: () => ({ ...urls }),
};
