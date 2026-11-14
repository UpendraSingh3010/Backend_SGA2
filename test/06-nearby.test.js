/**
 * FLOW 6 - Nearby vehicle search using mocked geolocation services
 */
const { expect } = require('chai');
const sinon = require('sinon');
const geocoder = require('../src/services/maps/geocoder');
const nominatim = require('../src/services/maps/providers/nominatim');
const { HttpError } = require('../src/shared/errors');
const { resetDb, createFleetUsers, createVehicle, api } = require('./support/helpers');

// Reference point: India Gate, New Delhi
const CENTER = { lat: 28.6129, lng: 77.2295 };

describe('Flow 6: Nearby vehicle search (mocked geolocation)', () => {
  let tokens;

  beforeEach(async () => {
    await resetDb();
    ({ tokens } = await createFleetUsers());
    await createVehicle({ registrationNumber: 'NEAR0KM', lat: 28.6129, lng: 77.2295, status: 'active' }); // 0 km
    await createVehicle({ registrationNumber: 'CP2KM', lat: 28.6315, lng: 77.2167, status: 'idle' }); // ~2.4 km
    await createVehicle({ registrationNumber: 'SAKET10KM', lat: 28.5245, lng: 77.2066, status: 'active' }); // ~10 km
    await createVehicle({ registrationNumber: 'MUMBAI', lat: 19.076, lng: 72.8777, status: 'active' }); // ~1150 km
    await createVehicle({ registrationNumber: 'NOGPS', lat: null }); // no location yet
  });

  afterEach(() => sinon.restore());

  it('returns vehicles within the radius, nearest first, with distanceKm', async () => {
    const res = await api('get', `/api/maps/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radiusKm=5`, tokens.driver);

    expect(res.status).to.equal(200);
    expect(res.headers['x-served-by']).to.equal('maps-service');
    expect(res.body.center).to.deep.equal({ ...CENTER, source: 'coordinates' });
    expect(res.body.radiusKm).to.equal(5);
    expect(res.body.vehicles.map((v) => v.registrationNumber)).to.deep.equal(['NEAR0KM', 'CP2KM']);
    expect(res.body.vehicles[0].distanceKm).to.equal(0);
    expect(res.body.vehicles[1].distanceKm).to.be.within(2.3, 2.6);
  });

  it('a larger radius includes more vehicles but never far-away ones', async () => {
    const res = await api('get', `/api/maps/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radiusKm=15`, tokens.admin);
    expect(res.body.vehicles.map((v) => v.registrationNumber)).to.deep.equal(['NEAR0KM', 'CP2KM', 'SAKET10KM']);
  });

  it('filters by status', async () => {
    const res = await api('get', `/api/maps/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radiusKm=15&status=active`, tokens.admin);
    expect(res.body.vehicles.map((v) => v.registrationNumber)).to.deep.equal(['NEAR0KM', 'SAKET10KM']);
  });

  it('geocodes an address centre using a mocked geocoder (sinon stub)', async () => {
    const stub = sinon.stub(geocoder, 'geocode').resolves({
      lat: CENTER.lat,
      lng: CENTER.lng,
      displayName: 'Stubbed India Gate',
      provider: 'stub',
    });

    const res = await api('get', '/api/maps/nearby?address=Rajpath%20Area&radiusKm=3', tokens.admin);

    expect(stub.calledOnceWithExactly('Rajpath Area')).to.equal(true);
    expect(res.status).to.equal(200);
    expect(res.body.center).to.deep.equal({ ...CENTER, source: 'geocoded', address: 'Stubbed India Gate' });
    expect(res.body.count).to.equal(2);
  });

  it('returns 404 ADDRESS_NOT_FOUND when the geocoder finds nothing', async () => {
    sinon.stub(geocoder, 'geocode').resolves(null);
    const res = await api('get', '/api/maps/nearby?address=Atlantis', tokens.admin);
    expect(res.status).to.equal(404);
    expect(res.body.error.code).to.equal('ADDRESS_NOT_FOUND');
  });

  it('returns 502 when the external geocoding provider is down', async () => {
    sinon.stub(geocoder, 'geocode').rejects(new HttpError(502, 'Geocoding provider (OpenStreetMap Nominatim) is unreachable', { code: 'GEOCODER_UNAVAILABLE' }));
    const res = await api('get', '/api/maps/nearby?address=Anywhere', tokens.admin);
    expect(res.status).to.equal(502);
    expect(res.body.error.code).to.equal('GEOCODER_UNAVAILABLE');
  });

  it('validates the radius and centre', async () => {
    const badRadius = await api('get', `/api/maps/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radiusKm=-1`, tokens.admin);
    expect(badRadius.status).to.equal(400);
    expect(badRadius.body.error.code).to.equal('INVALID_RADIUS');

    const tooBig = await api('get', `/api/maps/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radiusKm=10000`, tokens.admin);
    expect(tooBig.status).to.equal(400);

    const noCenter = await api('get', '/api/maps/nearby?radiusKm=5', tokens.admin);
    expect(noCenter.status).to.equal(400);

    const badLat = await api('get', '/api/maps/nearby?lat=200&lng=77&radiusKm=5', tokens.admin);
    expect(badLat.body.error.code).to.equal('INVALID_COORDINATES');
  });

  it('GET /api/maps/geocode uses the (mock) provider', async () => {
    const res = await api('get', '/api/maps/geocode?address=India%20Gate', tokens.driver);
    expect(res.status).to.equal(200);
    expect(res.body).to.include({ lat: 28.6129, lng: 77.2295, provider: 'mock' });
  });

  it('GET /api/maps/vehicles returns GeoJSON for every vehicle that has a location', async () => {
    const res = await api('get', '/api/maps/vehicles', tokens.driver);
    expect(res.body.type).to.equal('FeatureCollection');
    expect(res.body.features).to.have.length(4);
    expect(res.body.features[0].geometry.type).to.equal('Point');
    expect(res.body.features.map((f) => f.properties.registrationNumber)).to.not.include('NOGPS');
  });

  describe('OpenStreetMap Nominatim provider (HTTP mocked)', () => {
    it('sends the required User-Agent and parses the response', async () => {
      const fetchStub = sinon.stub(global, 'fetch').resolves(
        new Response(JSON.stringify([{ lat: '28.6129', lon: '77.2295', display_name: 'India Gate, New Delhi' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
      const result = await nominatim.geocode('India Gate test query');

      expect(result).to.deep.equal({ lat: 28.6129, lng: 77.2295, displayName: 'India Gate, New Delhi', provider: 'nominatim' });
      const [url, options] = fetchStub.firstCall.args;
      expect(String(url)).to.contain('/search').and.contain('q=India+Gate+test+query');
      expect(options.headers['User-Agent']).to.match(/FleetManagementSystem/);
    });

    it('returns null when nothing matches and 502 when the provider fails', async () => {
      const fetchStub = sinon.stub(global, 'fetch');
      fetchStub.onFirstCall().resolves(new Response('[]', { status: 200 }));
      fetchStub.onSecondCall().resolves(new Response('busy', { status: 503 }));

      expect(await nominatim.geocode('no-such-place-xyz')).to.equal(null);
      try {
        await nominatim.geocode('provider-down-xyz');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.status).to.equal(502);
      }
    });
  });
});
