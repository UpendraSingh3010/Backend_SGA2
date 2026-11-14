/** Shared, mutable test context filled in by test/hooks.js. */
module.exports = {
  API_KEY: 'test-api-key',
  SECOND_API_KEY: 'second-test-key',
  gateway: null, // Express app of the API Gateway
  servers: [],
  serviceUrls: {},
};
