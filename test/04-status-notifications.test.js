/**
 * FLOW 4 - Vehicle operational status update and notification triggering
 */
const { expect } = require('chai');
const sinon = require('sinon');
const { Notification, Vehicle } = require('../src/shared/models');
const registry = require('../src/shared/registry');
const sms = require('../src/services/notifications/sms');
const stubProvider = require('../src/services/notifications/sms/stubProvider');
const { deadUrl } = require('./support/servers');
const { resetDb, createFleetUsers, createVehicle, api } = require('./support/helpers');

describe('Flow 4: Status update and SMS notification triggering', () => {
  let tokens;
  let users;
  let vehicle;

  beforeEach(async () => {
    await resetDb();
    stubProvider.clearOutbox();
    ({ users, tokens } = await createFleetUsers());
    vehicle = await createVehicle({ registrationNumber: 'DL03CD5678', status: 'active', assignedDriver: users.driver._id });
  });

  afterEach(() => sinon.restore());

  it('changes the status and notifies admins, fleet managers and the assigned driver', async () => {
    const res = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.manager).send({
      status: 'maintenance',
      reason: 'Brake inspection',
    });

    expect(res.status).to.equal(200);
    expect(res.body).to.include({ statusChanged: true, previousStatus: 'active' });
    expect(res.body.vehicle.status).to.equal('maintenance');
    // 2 admins + 1 manager + assigned driver; one admin's number always fails on the stub
    expect(res.body.notification).to.deep.equal({ triggered: true, total: 4, sent: 3, failed: 1 });

    const notes = await Notification.find({ type: 'status_change' });
    const phones = notes.map((n) => n.recipient.phone);
    expect(phones).to.have.members([
      users.admin.phone,
      users.failingAdmin.phone,
      users.manager.phone,
      users.driver.phone,
    ]);
    expect(phones).to.not.include(users.otherDriver.phone);

    const sent = notes.find((n) => n.recipient.phone === users.driver.phone);
    expect(sent.status).to.equal('sent');
    expect(sent.event).to.equal('active->maintenance');
    expect(sent.message).to.contain('active -> maintenance').and.contain('Brake inspection');

    // the stub "phone outbox" received exactly the 3 successful messages
    expect(stubProvider.outbox()).to.have.length(3);

    // status history recorded
    const stored = await Vehicle.findById(vehicle._id);
    expect(stored.statusHistory).to.have.length(1);
    expect(stored.statusHistory[0]).to.include({ from: 'active', to: 'maintenance', reason: 'Brake inspection' });
  });

  it('does not notify anyone when the status does not actually change', async () => {
    const res = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.admin).send({ status: 'active' });
    expect(res.status).to.equal(200);
    expect(res.body.statusChanged).to.equal(false);
    expect(res.body.notification.triggered).to.equal(false);
    expect(await Notification.countDocuments()).to.equal(0);
  });

  it('skips users who disabled notifications', async () => {
    users.manager.notificationsEnabled = false;
    await users.manager.save();
    const res = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.admin).send({ status: 'idle' });
    expect(res.body.notification.total).to.equal(3);
  });

  it('rejects an invalid status with 400', async () => {
    const res = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.admin).send({ status: 'flying' });
    expect(res.status).to.equal(400);
    expect(await Notification.countDocuments()).to.equal(0);
  });

  it('lets the assigned driver change status but not another driver', async () => {
    const own = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.driver).send({ status: 'emergency', reason: 'Accident' });
    expect(own.status).to.equal(200);

    const other = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.otherDriver).send({ status: 'idle' });
    expect(other.status).to.equal(403);
  });

  it('records every notification as failed when the SMS provider rejects them (sinon stub)', async () => {
    const sendStub = sinon.stub(sms, 'send').resolves({ success: false, error: 'Carrier outage', provider: 'stub' });

    const res = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.admin).send({ status: 'out_of_service' });

    expect(res.status).to.equal(200); // the status change itself still succeeds
    expect(res.body.notification).to.include({ total: 4, sent: 0, failed: 4 });
    expect(sendStub.callCount).to.equal(4);
    expect(sendStub.firstCall.args[0].body).to.contain('active -> out_of_service');
    const failed = await Notification.find({ status: 'failed' });
    expect(failed).to.have.length(4);
    expect(failed[0].error).to.equal('Carrier outage');
  });

  it('records a failure when the SMS provider throws', async () => {
    sinon.stub(stubProvider, 'send').rejects(new Error('socket hang up'));
    const res = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.admin).send({ status: 'idle' });
    expect(res.body.notification.failed).to.equal(4);
    const note = await Notification.findOne();
    expect(note.error).to.equal('socket hang up');
  });

  it('retries a failed notification (POST /api/notifications/:id/retry)', async () => {
    sinon.stub(sms, 'send').resolves({ success: false, error: 'Temporary failure', provider: 'stub' });
    await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.admin).send({ status: 'idle' });
    sinon.restore(); // provider works again

    const failed = await Notification.findOne({ 'recipient.phone': users.manager.phone });
    const res = await api('post', `/api/notifications/${failed.id}/retry`, tokens.admin);
    expect(res.status).to.equal(200);
    expect(res.body.notification).to.include({ status: 'sent', attempts: 2 });

    const again = await api('post', `/api/notifications/${failed.id}/retry`, tokens.admin);
    expect(again.status).to.equal(409);
  });

  it('still updates the status if the Notification Service is down', async () => {
    const original = registry.get('notifications');
    registry.set('notifications', await deadUrl());
    try {
      const res = await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.admin).send({ status: 'idle' });
      expect(res.status).to.equal(200);
      expect(res.body.statusChanged).to.equal(true);
      expect(res.body.notification.triggered).to.equal(false);
      expect(res.body.notification.error).to.contain('unavailable');
    } finally {
      registry.set('notifications', original);
    }
  });

  it('exposes delivery records and stats for fleet managers', async () => {
    await api('patch', `/api/vehicles/${vehicle.id}/status`, tokens.admin).send({ status: 'idle' });

    const failedOnly = await api('get', '/api/notifications?status=failed', tokens.manager);
    expect(failedOnly.status).to.equal(200);
    expect(failedOnly.body.total).to.equal(1);
    expect(failedOnly.body.data[0].recipient.phone).to.equal('+919800000000');

    const stats = await api('get', '/api/notifications/stats', tokens.manager);
    expect(stats.body).to.deep.include({ total: 4, byStatus: { pending: 0, sent: 3, failed: 1 }, provider: 'stub' });
  });
});
