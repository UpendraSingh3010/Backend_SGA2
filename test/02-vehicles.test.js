/**
 * FLOW 2 - Vehicle registration and retrieval
 */
const { expect } = require('chai');
const { Vehicle } = require('../src/shared/models');
const { resetDb, createFleetUsers, createVehicle, api } = require('./support/helpers');

describe('Flow 2: Vehicle registration and retrieval', () => {
  let tokens;
  let users;

  beforeEach(async () => {
    await resetDb();
    ({ users, tokens } = await createFleetUsers());
  });

  describe('POST /api/vehicles', () => {
    it('registers a vehicle with GPS coordinates (fleet manager)', async () => {
      const res = await api('post', '/api/vehicles', tokens.manager).send({
        registrationNumber: 'dl01ab1234', // normalised to upper case
        make: 'Tata',
        model: 'Ace Gold',
        year: 2022,
        type: 'truck',
        latitude: 28.6139,
        longitude: 77.209,
        assignedDriverId: String(users.driver._id),
      });

      expect(res.status).to.equal(201);
      expect(res.headers['x-served-by']).to.equal('vehicles-service');
      const { vehicle } = res.body;
      expect(vehicle).to.include({ registrationNumber: 'DL01AB1234', status: 'idle', locationSource: 'manual' });
      expect(vehicle.location).to.deep.equal({ type: 'Point', coordinates: [77.209, 28.6139] });
      expect(vehicle.position).to.deep.equal({ lat: 28.6139, lng: 77.209 });
      expect(vehicle.assignedDriver).to.equal(String(users.driver._id));
      expect(res.body).to.not.have.property('geocoding');

      // persisted in MongoDB
      const stored = await Vehicle.findById(vehicle.id);
      expect(stored.registrationNumber).to.equal('DL01AB1234');
      expect(String(stored.createdBy)).to.equal(String(users.manager._id));
    });

    it('geocodes the address through the Geolocation Service when no coordinates are given', async () => {
      const res = await api('post', '/api/vehicles', tokens.admin).send({
        registrationNumber: 'DL10XY4321',
        make: 'Tata',
        model: 'Intra',
        address: 'Connaught Place, New Delhi',
      });

      expect(res.status).to.equal(201);
      expect(res.body.geocoding).to.include({ success: true, provider: 'mock' });
      expect(res.body.vehicle.locationSource).to.equal('geocoded');
      expect(res.body.vehicle.position).to.deep.equal({ lat: 28.6315, lng: 77.2167 });
    });

    it('still registers the vehicle (without location) when the address cannot be geocoded', async () => {
      const res = await api('post', '/api/vehicles', tokens.admin).send({
        registrationNumber: 'XX00NOWHERE',
        make: 'Tata',
        model: 'Intra',
        address: 'Nowhere Land 404',
      });
      expect(res.status).to.equal(201);
      expect(res.body.geocoding.success).to.equal(false);
      expect(res.body.vehicle.position).to.equal(null);
    });

    it('rejects missing required fields with 400 and per-field details', async () => {
      const res = await api('post', '/api/vehicles', tokens.admin).send({ registrationNumber: 'DL01AA0001' });
      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('VALIDATION_ERROR');
      const fields = res.body.error.details.map((d) => d.field);
      expect(fields).to.include.members(['make', 'model']);
    });

    it('rejects invalid coordinates with 400', async () => {
      const res = await api('post', '/api/vehicles', tokens.admin).send({
        registrationNumber: 'DL01AA0002',
        make: 'Tata',
        model: 'Ace',
        latitude: 123,
        longitude: 77,
      });
      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('INVALID_COORDINATES');
    });

    it('rejects a duplicate registration number with 409', async () => {
      await createVehicle({ registrationNumber: 'DL01AB1234' });
      const res = await api('post', '/api/vehicles', tokens.admin).send({
        registrationNumber: 'DL01AB1234',
        make: 'Tata',
        model: 'Ace',
      });
      expect(res.status).to.equal(409);
      expect(res.body.error.code).to.equal('DUPLICATE_RESOURCE');
    });

    it('rejects assigning a non-driver user as driver', async () => {
      const res = await api('post', '/api/vehicles', tokens.admin).send({
        registrationNumber: 'DL01AA0003',
        make: 'Tata',
        model: 'Ace',
        assignedDriverId: String(users.manager._id),
      });
      expect(res.status).to.equal(400);
    });
  });

  describe('GET /api/vehicles and /api/vehicles/:id', () => {
    it('retrieves a registered vehicle by id', async () => {
      const created = await api('post', '/api/vehicles', tokens.admin).send({
        registrationNumber: 'UP16GH3456',
        make: 'Eicher',
        model: 'Pro 2049',
        latitude: 28.5708,
        longitude: 77.3261,
      });
      const res = await api('get', `/api/vehicles/${created.body.vehicle.id}`, tokens.driver);
      expect(res.status).to.equal(200);
      expect(res.body.vehicle).to.deep.equal(created.body.vehicle);
    });

    it('lists vehicles with status filter and pagination metadata', async () => {
      await createVehicle({ status: 'active' });
      await createVehicle({ status: 'active' });
      await createVehicle({ status: 'maintenance' });

      const all = await api('get', '/api/vehicles?limit=2&page=1', tokens.manager);
      expect(all.status).to.equal(200);
      expect(all.body).to.include({ total: 3, page: 1, limit: 2 });
      expect(all.body.data).to.have.length(2);

      const maint = await api('get', '/api/vehicles?status=maintenance', tokens.manager);
      expect(maint.body.total).to.equal(1);
      expect(maint.body.data[0].status).to.equal('maintenance');
    });

    it('returns 404 for an unknown vehicle id', async () => {
      const res = await api('get', '/api/vehicles/000000000000000000000000', tokens.admin);
      expect(res.status).to.equal(404);
      expect(res.body.error.code).to.equal('VEHICLE_NOT_FOUND');
    });

    it('returns 400 for a malformed vehicle id', async () => {
      const res = await api('get', '/api/vehicles/not-an-id', tokens.admin);
      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('INVALID_ID');
    });

    it('updates vehicle details and re-geocodes a new address', async () => {
      const v = await createVehicle();
      const res = await api('patch', `/api/vehicles/${v.id}`, tokens.manager).send({ model: 'Ace EV', address: 'Saket, New Delhi' });
      expect(res.status).to.equal(200);
      expect(res.body.vehicle.model).to.equal('Ace EV');
      expect(res.body.vehicle.position).to.deep.equal({ lat: 28.5245, lng: 77.2066 });
    });
  });
});
