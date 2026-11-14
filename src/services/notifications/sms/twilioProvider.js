/**
 * Twilio SMS provider (works with a Twilio trial/sandbox account).
 * Uses Twilio's REST API directly with fetch, so no SDK dependency is needed.
 * Trial accounts can only send to phone numbers verified in the Twilio console.
 */
const config = require('../../../config');

module.exports = {
  name: 'twilio',

  isConfigured() {
    const { accountSid, authToken, from } = config.sms.twilio;
    return Boolean(accountSid && authToken && from);
  },

  async send({ to, body }) {
    const { accountSid, authToken, from } = config.sms.twilio;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { success: false, error: `Twilio error ${data.code || res.status}: ${data.message || res.statusText}` };
      }
      return { success: true, messageId: data.sid };
    } catch (err) {
      return { success: false, error: `Twilio request failed: ${err.message}` };
    }
  },
};
