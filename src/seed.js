/**
 * Demo data: users for every role and a fleet of vehicles around Delhi NCR.
 * Phone numbers are fake. +919800000000 ends in "0000", so the SMS stub always
 * fails it, which shows a 'failed' notification record in the demo.
 */
const { User, Vehicle, Telemetry, Notification } = require('./shared/models');
const { toPoint } = require('./shared/geo');

const USERS = [
  { key: 'admin', name: 'Asha Admin', email: 'admin@fleet.local', role: 'admin', phone: '+919800000001', password: 'Admin@123' },
  { key: 'nightAdmin', name: 'Night Shift Admin', email: 'night.admin@fleet.local', role: 'admin', phone: '+919800000000', password: 'Admin@123' },
  { key: 'manager', name: 'Manish Manager', email: 'manager@fleet.local', role: 'fleet_manager', phone: '+919800000002', password: 'Manager@123' },
  { key: 'driver1', name: 'Dev Driver', email: 'driver1@fleet.local', role: 'driver', phone: '+919800000003', password: 'Driver@123' },
  { key: 'driver2', name: 'Divya Driver', email: 'driver2@fleet.local', role: 'driver', phone: '+919800000004', password: 'Driver@123' },
];

const VEHICLES = [
  { registrationNumber: 'DL01AB1234', make: 'Tata', model: 'Ace Gold', year: 2022, type: 'truck', status: 'active', address: 'Connaught Place, New Delhi', lat: 28.6315, lng: 77.2167, driver: 'driver1' },
  { registrationNumber: 'DL03CD5678', make: 'Mahindra', model: 'Bolero Pickup', year: 2021, type: 'truck', status: 'active', address: 'India Gate, New Delhi', lat: 28.6129, lng: 77.2295, driver: 'driver2' },
  { registrationNumber: 'DL08IJ7890', make: 'Tata', model: 'Nexon EV', year: 2023, type: 'car', status: 'maintenance', address: 'Karol Bagh, New Delhi', lat: 28.6519, lng: 77.1909 },
  { registrationNumber: 'DL05KL2345', make: 'Force', model: 'Traveller', year: 2020, type: 'van', status: 'active', address: 'Saket, New Delhi', lat: 28.5245, lng: 77.2066 },
  { registrationNumber: 'HR26EF9012', make: 'Ashok Leyland', model: 'Dost+', year: 2022, type: 'truck', status: 'idle', address: 'Cyber City, Gurugram', lat: 28.495, lng: 77.089 },
  { registrationNumber: 'UP16GH3456', make: 'Eicher', model: 'Pro 2049', year: 2019, type: 'truck', status: 'active', address: 'Sector 18, Noida', lat: 28.5708, lng: 77.3261 },
  { registrationNumber: 'HR55MN6789', make: 'BharatBenz', model: '1617R', year: 2018, type: 'truck', status: 'out_of_service', address: 'Manesar, Haryana', lat: 28.354, lng: 76.9366 },
  { registrationNumber: 'UP14OP0123', make: 'Ola', model: 'S1 Pro', year: 2024, type: 'motorcycle', status: 'idle', address: 'Ghaziabad, Uttar Pradesh', lat: 28.6692, lng: 77.4538 },
];

async function seedDatabase({ reset = true, log = console.log } = {}) {
  if (reset) {
    await Promise.all([User.deleteMany({}), Vehicle.deleteMany({}), Telemetry.deleteMany({}), Notification.deleteMany({})]);
  }

  const users = {};
  for (const u of USERS) {
    let user = await User.findOne({ email: u.email });
    if (!user) {
      user = new User({ name: u.name, email: u.email, role: u.role, phone: u.phone });
      await user.setPassword(u.password);
      await user.save();
    }
    users[u.key] = user;
  }

  const now = Date.now();
  for (const [i, v] of VEHICLES.entries()) {
    if (await Vehicle.exists({ registrationNumber: v.registrationNumber })) continue;
    const location = toPoint(v.lat, v.lng);
    const recordedAt = new Date(now - (i + 1) * 5 * 60_000);
    const vehicle = await Vehicle.create({
      registrationNumber: v.registrationNumber,
      make: v.make,
      model: v.model,
      year: v.year,
      type: v.type,
      status: v.status,
      address: v.address,
      location,
      locationSource: 'gps',
      lastSeenAt: recordedAt,
      lastTelemetry: { speedKmh: 20 + i * 5, batteryLevel: 80 - i * 5, fuelLevel: 60, engineTempC: 85, recordedAt },
      assignedDriver: v.driver ? users[v.driver]._id : undefined,
      createdBy: users.admin._id,
    });
    await Telemetry.create({
      vehicle: vehicle._id,
      registrationNumber: vehicle.registrationNumber,
      recordedAt,
      location,
      speedKmh: 20 + i * 5,
      batteryLevel: 80 - i * 5,
      fuelLevel: 60,
      engineTempC: 85,
      odometerKm: 10_000 + i * 1234,
    });
  }

  log(`[seed] ${await User.countDocuments()} users, ${await Vehicle.countDocuments()} vehicles ready`);
  return users;
}

module.exports = { seedDatabase, USERS, VEHICLES };
