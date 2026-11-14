/**
 * Notification Service - sends SMS for critical vehicle events and status
 * changes, and keeps a record of each notification (sent / failed).
 * Routes are mounted at /api/notifications/*.
 */
const express = require('express');
const mongoose = require('mongoose');
const createServiceApp = require('../../shared/createServiceApp');
const { Vehicle, Notification, Telemetry, User } = require('../../shared/models');
const { HttpError } = require('../../shared/errors');
const { ROLES, authenticate, authorize, authenticateOrInternal } = require('../../shared/auth');
const notifier = require('./notifier');
const stubProvider = require('./sms/stubProvider');
const sms = require('./sms');

function requireObjectId(value, field) {
  if (!value || !mongoose.isValidObjectId(value)) {
    throw new HttpError(400, `${field} must be a valid id`, { code: 'VALIDATION_ERROR' });
  }
  return value;
}

function createNotificationsApp() {
  const router = express.Router();
  const staff = [ROLES.ADMIN, ROLES.FLEET_MANAGER];

  /**
   * Vehicle event intake - called by the Telemetry Service (critical events)
   * and the Vehicle Service (status changes) using the internal key.
   * Admins can also call it directly to test notifications.
   */
  router.post('/api/notifications/events', authenticateOrInternal(ROLES.ADMIN), async (req, res) => {
    const { type, vehicleId, events, details, previousStatus, newStatus, reason } = req.body || {};
    if (!['critical_event', 'status_change'].includes(type)) {
      throw new HttpError(400, "type must be 'critical_event' or 'status_change'", { code: 'VALIDATION_ERROR' });
    }
    requireObjectId(vehicleId, 'vehicleId');
    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle) throw new HttpError(404, 'Vehicle not found');

    let message;
    let event;
    if (type === 'critical_event') {
      const list = Array.isArray(events) ? events : [events].filter(Boolean);
      const invalid = list.filter((e) => !Telemetry.CRITICAL_EVENTS.includes(e));
      if (list.length === 0 || invalid.length) {
        throw new HttpError(400, `events must contain one or more of: ${Telemetry.CRITICAL_EVENTS.join(', ')}`, {
          code: 'VALIDATION_ERROR',
        });
      }
      event = list.join(',');
      message = notifier.buildCriticalMessage(vehicle, list, details || {});
    } else {
      if (!newStatus) throw new HttpError(400, 'newStatus is required', { code: 'VALIDATION_ERROR' });
      event = `${previousStatus || 'unknown'}->${newStatus}`;
      message = notifier.buildStatusMessage(vehicle, previousStatus || 'unknown', newStatus, reason);
    }

    const users = await notifier.resolveRecipients(type, vehicle);
    const notifications = await notifier.notifyUsers({ type, vehicle, event, message, users });
    res.status(201).json(notifier.summarize(notifications));
  });

  // Manually send an SMS (admin) - useful to test the SMS integration
  router.post('/api/notifications/sms', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
    const { phone, message, userId } = req.body || {};
    if (!message) throw new HttpError(400, 'message is required', { code: 'VALIDATION_ERROR' });
    let recipient = { phone };
    if (userId) {
      const user = await User.findById(requireObjectId(userId, 'userId'));
      if (!user) throw new HttpError(404, 'User not found');
      recipient = { user: user._id, name: user.name, role: user.role, phone: user.phone };
    }
    if (!recipient.phone) throw new HttpError(400, 'phone or userId is required', { code: 'VALIDATION_ERROR' });

    const notification = await Notification.create({ type: 'manual', recipient, message, status: 'pending' });
    await notifier.deliver(notification);
    res.status(201).json({ notification });
  });

  router.get('/api/notifications', authenticate, authorize(...staff), async (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.vehicleId) filter.vehicle = requireObjectId(req.query.vehicleId, 'vehicleId');
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);

    const [data, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Notification.countDocuments(filter),
    ]);
    res.json({ data, page, limit, total });
  });

  router.get('/api/notifications/stats', authenticate, authorize(...staff), async (req, res) => {
    const rows = await Notification.aggregate([
      { $group: { _id: { status: '$status', type: '$type' }, count: { $sum: 1 } } },
    ]);
    const stats = { total: 0, byStatus: { pending: 0, sent: 0, failed: 0 }, byType: {} };
    for (const { _id, count } of rows) {
      stats.total += count;
      stats.byStatus[_id.status] = (stats.byStatus[_id.status] || 0) + count;
      stats.byType[_id.type] = (stats.byType[_id.type] || 0) + count;
    }
    res.json({ ...stats, provider: sms.provider().name });
  });

  // Messages accepted by the SMS stub (what the "phones" would have received)
  router.get('/api/notifications/outbox', authenticate, authorize(ROLES.ADMIN), (req, res) => {
    res.json({ provider: 'stub', messages: stubProvider.outbox() });
  });

  router.get('/api/notifications/:id', authenticate, authorize(...staff), async (req, res) => {
    const notification = await Notification.findById(requireObjectId(req.params.id, 'id'));
    if (!notification) throw new HttpError(404, 'Notification not found');
    res.json({ notification });
  });

  // Re-send a failed notification
  router.post('/api/notifications/:id/retry', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
    const notification = await Notification.findById(requireObjectId(req.params.id, 'id'));
    if (!notification) throw new HttpError(404, 'Notification not found');
    if (notification.status !== 'failed') {
      throw new HttpError(409, `Only failed notifications can be retried (current status: ${notification.status})`, {
        code: 'INVALID_STATE',
      });
    }
    await notifier.deliver(notification);
    res.json({ notification });
  });

  return createServiceApp('notifications', router);
}

module.exports = { createNotificationsApp };
