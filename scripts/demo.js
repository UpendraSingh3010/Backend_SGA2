/**
 * End-to-end demo against a RUNNING system (start it first with `npm start`).
 * Walks through every scenario needed for the assignment screenshots:
 *   1. API Gateway routing + API key verification
 *   2. Vehicle geolocation (address -> coordinates) and nearby search
 *   3. SMS notification for a critical event and a status change
 *   4. RBAC (driver cannot delete a vehicle)
 *   5. Rate limiting (optional: `npm run demo -- --rate-limit`)
 *
 * Options: BASE_URL (default http://localhost:8080), API_KEY (default dev-api-key-123)
 */
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`;
const API_KEY = process.env.API_KEY || (process.env.API_KEYS || 'dev-api-key-123').split(',')[0];
const RUN_RATE_LIMIT = process.argv.includes('--rate-limit');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

let step = 0;
function heading(title) {
  step += 1;
  console.log(`\n${c.bold(c.cyan(`━━ ${step}. ${title} `.padEnd(72, '━')))}`);
}

async function call(method, path, { token, body, apiKey = API_KEY, quiet = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!quiet) {
    const color = res.status < 300 ? c.green : res.status < 500 ? c.yellow : c.red;
    const via = res.headers.get('x-served-by') ? c.dim(` via ${res.headers.get('x-served-by')}`) : c.dim(' (answered by gateway)');
    console.log(`${c.bold(method.padEnd(6))} ${path}  ->  ${color(res.status)}${via}`);
  }
  return { status: res.status, data, headers: res.headers };
}

const show = (obj) => console.log(c.dim(JSON.stringify(obj, null, 2).split('\n').map((l) => `   ${l}`).join('\n')));

async function main() {
  console.log(c.bold(`Fleet Management System demo  ->  ${BASE_URL}`));

  heading('Gateway health (public)');
  const health = await call('GET', '/health', { apiKey: null });
  show(health.data);

  heading('API key verification');
  show((await call('GET', '/api/vehicles', { apiKey: null })).data.error);
  show((await call('GET', '/api/vehicles', { apiKey: 'not-a-real-key' })).data.error);
  show((await call('GET', '/api/does-not-exist')).data.error);

  heading('Login (User Service) -> JWT');
  const login = await call('POST', '/api/users/login', { body: { email: 'admin@fleet.local', password: 'Admin@123' } });
  if (login.status !== 200) throw new Error('Admin login failed - did you seed the database?');
  const admin = login.data.token;
  show({ user: login.data.user.email, role: login.data.user.role, token: `${admin.slice(0, 40)}...` });
  const verify = await call('GET', '/api/users/verify-token', { token: admin });
  show(verify.data.claims);

  heading('Register a vehicle by ADDRESS (geocoded via Geolocation Service)');
  const reg = `DL${Math.floor(10 + Math.random() * 89)}DM${Math.floor(1000 + Math.random() * 8999)}`;
  const created = await call('POST', '/api/vehicles', {
    token: admin,
    body: { registrationNumber: reg, make: 'Tata', model: 'Intra V30', year: 2024, type: 'truck', status: 'active', address: 'India Gate, New Delhi' },
  });
  const vehicle = created.data.vehicle;
  show({ registrationNumber: vehicle.registrationNumber, position: vehicle.position, locationSource: vehicle.locationSource, geocoding: created.data.geocoding });

  heading('Vehicle sends GPS telemetry (stored + position updated)');
  const tel = await call('POST', '/api/telemetry', {
    token: admin,
    body: { vehicleId: vehicle.id, latitude: 28.6205, longitude: 77.2101, speedKmh: 38, batteryLevel: 82, fuelLevel: 64, engineTempC: 89 },
  });
  show({ stored: tel.data.telemetry.id, position: tel.data.telemetry.position, criticalEvents: tel.data.criticalEvents });

  heading('Nearby vehicles: within 3 km of Connaught Place (by coordinates)');
  const near = await call('GET', '/api/maps/nearby?lat=28.6315&lng=77.2167&radiusKm=3', { token: admin });
  console.log(`   ${near.data.count} vehicle(s) within ${near.data.radiusKm} km:`);
  near.data.vehicles.forEach((v) => console.log(`   • ${v.registrationNumber.padEnd(12)} ${v.status.padEnd(14)} ${v.distanceKm.toFixed(2)} km`));

  heading('Nearby vehicles: within 10 km of an ADDRESS (geocoded first)');
  const near2 = await call('GET', `/api/maps/nearby?address=${encodeURIComponent('Saket, New Delhi')}&radiusKm=10`, { token: admin });
  if (near2.status === 200) {
    console.log(`   centre: ${near2.data.center.address} (${near2.data.center.lat}, ${near2.data.center.lng})`);
    near2.data.vehicles.forEach((v) => console.log(`   • ${v.registrationNumber.padEnd(12)} ${v.status.padEnd(14)} ${v.distanceKm.toFixed(2)} km`));
  } else show(near2.data);

  heading('CRITICAL EVENT: engine fault -> SMS to fleet administrators');
  const crit = await call('POST', '/api/telemetry', {
    token: admin,
    body: { vehicleId: vehicle.id, latitude: 28.6211, longitude: 77.2112, speedKmh: 0, engineTempC: 124, faultCode: 'P0217', event: 'engine_fault' },
  });
  show({ criticalEvents: crit.data.criticalEvents, notification: crit.data.notification });

  heading('STATUS CHANGE: active -> maintenance -> SMS to relevant users');
  const st = await call('PATCH', `/api/vehicles/${vehicle.id}/status`, {
    token: admin,
    body: { status: 'maintenance', reason: 'Engine overheating - sent to workshop' },
  });
  show({ statusChanged: st.data.statusChanged, previousStatus: st.data.previousStatus, status: st.data.vehicle.status, notification: st.data.notification });

  heading('Notification records (sent / failed)');
  const notes = await call('GET', `/api/notifications?vehicleId=${vehicle.id}&limit=20`, { token: admin });
  notes.data.data.forEach((n) => {
    const s = n.status === 'sent' ? c.green('SENT  ') : c.red('FAILED');
    console.log(`   ${s} ${n.type.padEnd(15)} -> ${n.recipient.name.padEnd(18)} ${n.recipient.phone}${n.error ? c.dim(`  (${n.error})`) : ''}`);
  });
  console.log(c.dim(`   example message: "${notes.data.data[0].message}"`));

  heading('RBAC: a driver tries to delete the vehicle');
  const drv = await call('POST', '/api/users/login', { body: { email: 'driver1@fleet.local', password: 'Driver@123' }, quiet: true });
  show((await call('DELETE', `/api/vehicles/${vehicle.id}`, { token: drv.data.token })).data.error);
  await call('DELETE', `/api/vehicles/${vehicle.id}`, { token: admin });
  console.log(c.dim('   (admin deleted the demo vehicle -> 204)'));

  if (RUN_RATE_LIMIT) {
    heading('Rate limiting: burst of requests with one API key');
    const counts = {};
    let limited = null;
    for (let i = 0; i < 130; i += 1) {
      const r = await call('GET', '/api/maps/vehicles', { token: admin, quiet: true });
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.status === 429 && !limited) limited = r;
    }
    console.log(`   status codes: ${JSON.stringify(counts)}`);
    if (limited) {
      show(limited.data.error);
      console.log(c.dim(`   RateLimit: ${limited.headers.get('ratelimit')}   Retry-After: ${limited.headers.get('retry-after')}s`));
    }
  } else {
    console.log(c.dim('\n(Tip: run `npm run demo -- --rate-limit` to also demonstrate HTTP 429 rate limiting.)'));
  }

  console.log(`\n${c.green(c.bold('Demo complete.'))} Swagger UI: ${BASE_URL}/docs   Map: ${BASE_URL}/map\n`);
}

main().catch((err) => {
  console.error(c.red(`\nDemo failed: ${err.message}`));
  if (err.cause && err.cause.code === 'ECONNREFUSED') console.error(`Is the system running? Start it with: npm start`);
  process.exit(1);
});
