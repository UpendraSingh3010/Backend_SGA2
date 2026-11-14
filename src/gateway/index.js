/** Runs only the API Gateway (services must be started separately). */
const config = require('../config');
const { createGateway } = require('./app');

const port = config.ports.gateway;
createGateway().listen(port, () => {
  console.log(`[gateway] API Gateway listening on http://localhost:${port}`);
  console.log(`[gateway] Swagger UI: http://localhost:${port}/docs`);
});
