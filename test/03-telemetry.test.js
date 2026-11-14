/**
 * FLOW 3 - Vehicle telemetry submission and storage
 * (including critical-event detection -> SMS to fleet administrators)
 */
const { expect } = require('chai');
const { Telemetry, Vehicle, Notification } = require('../src/shared/models');
const { resetDb, createFleetUsers, createVehicle, api } = require('./support/helpers');

describe('Flow 3: Telemetry submission and storage', () => {
  let tokens;
  let users;
  let vehicle;

  beforeEach(async () => {
    await resetDb();
    ({ users, tokens } = await createFleetUsers());
    vehicle = await createVehicle({ registrationNumber: 'DL01AB1234', lat: 28.6, lng: 77.2, assignedDriver: users.driver._id });
  });

  const reading = (overrides = {}) => ({
    vehicleId: vehicle.id,
    latitude: 28.6139,
    longitude: 77.209,
    speedKmh: 42,
    heading: 90,
    batteryLevel: 76,
    fuelLevel: 55,
    engineTempC: 88,
    odometerKm: 12345,
    ...overrides,
  });

  it('stores a reading and updates the vehicle GPS position', async () => {
    const res = await api('post', '/api/telemetry', tokens.driver).send(reading());

    expect(res.status).to.equal(201);
    expect(res.headers['x-served-by']).to.equal('telemetry-service');
    expect(res.body.telemetry).to.include({ vehicle: vehicle.id, speedKmh: 42, batteryLevel: 76 });
    expect(res.body.telemetry.position).to.deep.equal({ lat: 28.6139, lng: 77.209 });
    expect(res.body.criticalEvents).to.deep.equal([]);
    expect(res.body.notification.triggered).to.equal(false);

    // stored in MongoDB
    const stored = await Telemetry.find({ vehicle: vehicle._id });
    expect(stored).to.have.length(1);
    expect(stored[0].location.coordinates).to.deep.equal([77.209, 28.6139]);
    expect(String(stored[0].submittedBy)).to.equal(String(users.driver._id));

    // vehicle position updated from GPS
    const v = await Vehicle.findById(vehicle._id);
    expect(v.location.coordinates).to.deep.equal([77.209, 28.6139]);
    expect(v.locationSource).to.equal('gps');
    expect(v.lastTelemetry.speedKmh).to.equal(42);

    expect(await Notification.countDocuments()).to.equal(0);
  });

  it('returns history newest-first and the latest reading', async () => {
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 3; i += 1) {
      await api('post', '/api/telemetry', tokens.admin).send(
        reading({ speedKmh: 10 * (i + 1), recordedAt: new Date(t0 + i * 10_000).toISOString() })
      );
    }
    const history = await api('get', `/api/telemetry/vehicles/${vehicle.id}`, tokens.manager);
    expect(history.status).to.equal(200);
    expect(history.body.count).to.equal(3);
    expect(history.body.data.map((t) => t.speedKmh)).to.deep.equal([30, 20, 10]);

    const latest = await api('get', `/api/telemetry/vehicles/${vehicle.id}/latest`, tokens.manager);
    expect(latest.body.telemetry.speedKmh).to.equal(30);
  });

  it('does not move the vehicle back in time for an out-of-order (older) reading', async () => {
    await api('post', '/api/telemetry', tokens.admin).send(reading({ latitude: 28.7, longitude: 77.3 }));
    await api('post', '/api/telemetry', tokens.admin).send(
      reading({ latitude: 10, longitude: 10, recordedAt: new Date(Date.now() - 3_600_000).toISOString() })
    );
    const v = await Vehicle.findById(vehicle._id);
    expect(v.location.coordinates).to.deep.equal([77.3, 28.7]);
    expect(await Telemetry.countDocuments({ vehicle: vehicle._id })).to.equal(2);
  });

  describe('critical events', () => {
    it('emergency_stop sends an SMS to every admin and records sent/failed status', async () => {
      const res = await api('post', '/api/telemetry', tokens.driver).send(reading({ speedKmh: 0, event: 'emergency_stop' }));

      expect(res.status).to.equal(201);
      expect(res.body.criticalEvents).to.deep.equal(['emergency_stop']);
      expect(res.body.notification).to.deep.equal({ triggered: true, total: 2, sent: 1, failed: 1 });

      const notes = await Notification.find({ type: 'critical_event' });
      expect(notes).to.have.length(2);
      expect(notes.every((n) => n.recipient.role === 'admin')).to.equal(true);

      const sent = notes.find((n) => n.status === 'sent');
      expect(sent.recipient.phone).to.equal('+919811111111');
      expect(sent.providerMessageId).to.match(/^SM_STUB_/);
      expect(sent.message).to.contain('EMERGENCY STOP').and.contain('DL01AB1234');

      const failed = notes.find((n) => n.status === 'failed');
      expect(failed.recipient.phone).to.equal('+919800000000');
      expect(failed.error).to.contain('Simulated carrier failure');
    });

    it('auto-detects low_battery and engine_fault from sensor thresholds', async () => {
      const res = await api('post', '/api/telemetry', tokens.admin).send(reading({ batteryLevel: 9, engineTempC: 121 }));
      expect(res.body.criticalEvents).to.have.members(['low_battery', 'engine_fault']);
      const [note] = await Notification.find({ status: 'sent' });
      expect(note.message).to.contain('ENGINE FAULT').and.contain('LOW BATTERY');
      expect(note.event).to.contain('low_battery');
    });

    it('treats an OBD fault code as an engine_fault', async () => {
      const res = await api('post', '/api/telemetry', tokens.admin).send(reading({ faultCode: 'P0217' }));
      expect(res.body.criticalEvents).to.deep.equal(['engine_fault']);
    });

    it('lists critical events via GET /api/telemetry/events', async () => {
      await api('post', '/api/telemetry', tokens.admin).send(reading());
      await api('post', '/api/telemetry', tokens.admin).send(reading({ event: 'engine_fault' }));
      const res = await api('get', '/api/telemetry/events?event=engine_fault', tokens.manager);
      expect(res.body.count).to.equal(1);
      expect(res.body.data[0].events).to.deep.equal(['engine_fault']);
    });
  });

  describe('validation and access', () => {
    it('rejects invalid coordinates with 400 INVALID_COORDINATES', async () => {
      const res = await api('post', '/api/telemetry', tokens.admin).send(reading({ latitude: 95 }));
      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('INVALID_COORDINATES');
      expect(await Telemetry.countDocuments()).to.equal(0);
    });

    it('rejects missing coordinates with 400', async () => {
      const res = await api('post', '/api/telemetry', tokens.admin).send({ vehicleId: vehicle.id, speedKmh: 3 });
      expect(res.status).to.equal(400);
    });

    it('rejects an unknown event type with 400', async () => {
      const res = await api('post', '/api/telemetry', tokens.admin).send(reading({ event: 'flat_tyre' }));
      expect(res.status).to.equal(400);
    });

    it('rejects out-of-range sensor values with 400', async () => {
      const res = await api('post', '/api/telemetry', tokens.admin).send(reading({ batteryLevel: 150 }));
      expect(res.status).to.equal(400);
      expect(res.body.error.details[0].field).to.equal('batteryLevel');
    });

    it('returns 404 for an unknown vehicle', async () => {
      const res = await api('post', '/api/telemetry', tokens.admin).send(reading({ vehicleId: '000000000000000000000000' }));
      expect(res.status).to.equal(404);
    });

    it('forbids a driver from submitting telemetry for a vehicle not assigned to them', async () => {
      const res = await api('post', '/api/telemetry', tokens.otherDriver).send(reading());
      expect(res.status).to.equal(403);
      expect(await Telemetry.countDocuments()).to.equal(0);
    });

    it('requires a JWT', async () => {
      const res = await api('post', '/api/telemetry').send(reading());
      expect(res.status).to.equal(401);
    });
  });
});
