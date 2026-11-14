/**
 * Builds SMS messages for vehicle events, resolves recipients and records
 * every attempt in the notifications collection (status: sent / failed).
 */
const { User, Notification } = require('../../shared/models');
const { ROLES } = require('../../shared/auth');
const { fromPoint } = require('../../shared/geo');
const sms = require('./sms');

const EVENT_LABELS = {
  engine_fault: 'ENGINE FAULT',
  low_battery: 'LOW BATTERY',
  emergency_stop: 'EMERGENCY STOP',
};

function vehicleLabel(vehicle) {
  return `${vehicle.registrationNumber} (${vehicle.make} ${vehicle.model})`;
}

function formatTime(date = new Date()) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function buildCriticalMessage(vehicle, events, details = {}) {
  const labels = events.map((e) => EVENT_LABELS[e] || String(e).toUpperCase()).join(' + ');
  const pos = fromPoint(details.location || vehicle.location);
  const where = pos ? ` at ${pos.lat.toFixed(5)},${pos.lng.toFixed(5)}` : '';
  const extras = [];
  if (details.batteryLevel !== undefined) extras.push(`battery ${details.batteryLevel}%`);
  if (details.engineTempC !== undefined) extras.push(`engine ${details.engineTempC}C`);
  if (details.faultCode) extras.push(`code ${details.faultCode}`);
  const extra = extras.length ? ` [${extras.join(', ')}]` : '';
  return `[FLEET ALERT] ${labels} reported by ${vehicleLabel(vehicle)}${where} on ${formatTime(details.recordedAt)}${extra}. Please take action.`;
}

function buildStatusMessage(vehicle, from, to, reason) {
  return `[FLEET] Vehicle ${vehicleLabel(vehicle)} status changed: ${from} -> ${to}${reason ? `. Reason: ${reason}` : ''} (${formatTime()}).`;
}

/**
 * Critical events -> fleet administrators.
 * Status changes  -> administrators, fleet managers and the assigned driver.
 */
async function resolveRecipients(type, vehicle) {
  const roles = type === 'critical_event' ? [ROLES.ADMIN] : [ROLES.ADMIN, ROLES.FLEET_MANAGER];
  const or = [{ role: { $in: roles } }];
  if (type === 'status_change' && vehicle.assignedDriver) or.push({ _id: vehicle.assignedDriver });

  return User.find({
    $or: or,
    active: true,
    notificationsEnabled: true,
    phone: { $exists: true, $ne: '' },
  });
}

async function deliver(notification) {
  notification.attempts += 1;
  const result = await sms.send({ to: notification.recipient.phone, body: notification.message });
  notification.provider = result.provider;
  if (result.success) {
    notification.status = 'sent';
    notification.providerMessageId = result.messageId;
    notification.error = undefined;
    notification.sentAt = new Date();
  } else {
    notification.status = 'failed';
    notification.error = result.error;
  }
  await notification.save();
  return notification;
}

async function notifyUsers({ type, vehicle, event, message, users }) {
  const results = [];
  for (const user of users) {
    const notification = await Notification.create({
      type,
      recipient: { user: user._id, name: user.name, role: user.role, phone: user.phone },
      vehicle: vehicle._id,
      registrationNumber: vehicle.registrationNumber,
      event,
      message,
      status: 'pending',
    });
    results.push(await deliver(notification));
  }
  return results;
}

function summarize(notifications) {
  return {
    triggered: notifications.length > 0,
    total: notifications.length,
    sent: notifications.filter((n) => n.status === 'sent').length,
    failed: notifications.filter((n) => n.status === 'failed').length,
    notifications,
  };
}

module.exports = {
  buildCriticalMessage,
  buildStatusMessage,
  resolveRecipients,
  notifyUsers,
  deliver,
  summarize,
};
