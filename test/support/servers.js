/** Start/stop Express apps on random free ports. */
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** A URL where nothing is listening (to simulate a service that is down). */
async function deadUrl() {
  const express = require('express');
  const { server, url } = await listen(express());
  await close(server);
  return url;
}

module.exports = { listen, close, deadUrl };
