const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const toJSON = require('./toJSON');
const { ROLES } = require('../auth');

const E164 = /^\+[1-9]\d{7,14}$/;

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email is not valid'],
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(ROLES), default: ROLES.DRIVER },
    phone: {
      type: String,
      trim: true,
      match: [E164, 'phone must be in E.164 format, e.g. +919876543210'],
    },
    notificationsEnabled: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.plugin(toJSON);

userSchema.methods.setPassword = async function setPassword(password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};

userSchema.methods.checkPassword = function checkPassword(password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.statics.E164 = E164;

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
