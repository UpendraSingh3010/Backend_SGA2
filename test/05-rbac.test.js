/**
 * FLOW 5 - Role-based access control
 * (e.g. unauthorized users attempting to delete a vehicle)
 */
const { expect } = require('chai');
const { Vehicle } = require('../src/shared/models');
const { resetDb, createFleetUsers, createVehicle, api } = require('./support/helpers');

describe('Flow 5: Role-based access control', () => {
  let tokens;
  let vehicle;

  beforeEach(async () => {
    await resetDb();
    ({ tokens } = await createFleetUsers());
    vehicle = await createVehicle();
  });

  describe('DELETE /api/vehicles/:id (admin only)', () => {
    it('forbids a driver: 403 INSUFFICIENT_ROLE and the vehicle is kept', async () => {
      const res = await api('delete', `/api/vehicles/${vehicle.id}`, tokens.driver);
      expect(res.status).to.equal(403);
      expect(res.body.error.code).to.equal('INSUFFICIENT_ROLE');
      expect(res.body.error.message).to.contain("Role 'driver'");
      expect(await Vehicle.exists({ _id: vehicle._id })).to.not.equal(null);
    });

    it('forbids a fleet manager: 403', async () => {
      const res = await api('delete', `/api/vehicles/${vehicle.id}`, tokens.manager);
      expect(res.status).to.equal(403);
      expect(await Vehicle.exists({ _id: vehicle._id })).to.not.equal(null);
    });

    it('rejects an anonymous request: 401', async () => {
      const res = await api('delete', `/api/vehicles/${vehicle.id}`);
      expect(res.status).to.equal(401);
      expect(await Vehicle.exists({ _id: vehicle._id })).to.not.equal(null);
    });

    it('allows an admin: 204, after which the vehicle is gone (404)', async () => {
      const res = await api('delete', `/api/vehicles/${vehicle.id}`, tokens.admin);
      expect(res.status).to.equal(204);
      expect(await Vehicle.exists({ _id: vehicle._id })).to.equal(null);

      const after = await api('get', `/api/vehicles/${vehicle.id}`, tokens.admin);
      expect(after.status).to.equal(404);
    });
  });

  describe('other role rules', () => {
    const newVehicle = { registrationNumber: 'RB00AC1234', make: 'Tata', model: 'Ace', latitude: 28.6, longitude: 77.2 };

    it('drivers cannot register vehicles; fleet managers can', async () => {
      const asDriver = await api('post', '/api/vehicles', tokens.driver).send(newVehicle);
      expect(asDriver.status).to.equal(403);
      const asManager = await api('post', '/api/vehicles', tokens.manager).send(newVehicle);
      expect(asManager.status).to.equal(201);
    });

    it('drivers cannot read notification records; fleet managers can', async () => {
      expect((await api('get', '/api/notifications', tokens.driver)).status).to.equal(403);
      expect((await api('get', '/api/notifications', tokens.manager)).status).to.equal(200);
    });

    it('only admins can send a manual SMS', async () => {
      const body = { phone: '+919811111111', message: 'Test' };
      expect((await api('post', '/api/notifications/sms', tokens.manager).send(body)).status).to.equal(403);
      const res = await api('post', '/api/notifications/sms', tokens.admin).send(body);
      expect(res.status).to.equal(201);
      expect(res.body.notification.status).to.equal('sent');
    });

    it('only admins can create users with privileged roles or list users', async () => {
      const body = { name: 'New Admin', email: 'new.admin@test.local', password: 'Secret@123', role: 'admin' };
      expect((await api('post', '/api/users', tokens.manager).send(body)).status).to.equal(403);
      expect((await api('post', '/api/users', tokens.admin).send(body)).status).to.equal(201);
      expect((await api('get', '/api/users', tokens.driver)).status).to.equal(403);
    });

    it('clients cannot impersonate an internal service with the x-internal-key header', async () => {
      // The gateway strips x-internal-key, so this lands as an unauthenticated call
      const res = await api('post', '/api/notifications/events')
        .set('x-internal-key', process.env.INTERNAL_SERVICE_KEY)
        .send({ type: 'critical_event', vehicleId: vehicle.id, events: ['engine_fault'] });
      expect(res.status).to.equal(401);
    });
  });
});
