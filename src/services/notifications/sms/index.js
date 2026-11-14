/**
 * Picks the SMS provider: Twilio when SMS_PROVIDER=twilio and credentials are
 * set, otherwise the custom stub. Calls go through `sms.send(...)` so tests can
 * stub them with sinon.
 */
const config = require('../../../config');
const stubProvider = require('./stubProvider');
const twilioProvider = require('./twilioProvider');

let warned = false;

const sms = {
  provider() {
    if (config.sms.provider === 'twilio') {
      if (twilioProvider.isConfigured()) return twilioProvider;
      if (!warned && process.env.NODE_ENV !== 'test') {
        console.warn('[notifications] SMS_PROVIDER=twilio but Twilio credentials are missing - using stub');
        warned = true;
      }
    }
    return stubProvider;
  },

  /** @returns {Promise<{success:boolean, messageId?:string, error?:string, provider:string}>} */
  async send({ to, body }) {
    const provider = this.provider();
    try {
      const result = await provider.send({ to, body });
      return { ...result, provider: provider.name };
    } catch (err) {
      return { success: false, error: err.message, provider: provider.name };
    }
  },
};

module.exports = sms;
