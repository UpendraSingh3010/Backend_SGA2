/**
 * Custom SMS stub - behaves like an SMS gateway without sending real messages.
 *
 * Magic numbers (similar to Twilio's test credentials) let you reproduce
 * failures on purpose:
 *   - any number ending in "0000"  -> simulated carrier failure
 *   - any number not in E.164 form -> invalid number failure
 * Every accepted message is kept in an in-memory outbox and printed to the console.
 */
const crypto = require('crypto');

const E164 = /^\+[1-9]\d{7,14}$/;
const outbox = [];
const MAX_OUTBOX = 200;

function printSms(msg) {
  if (process.env.NODE_ENV === 'test') return;
  const line = '-'.repeat(64);
  console.log(
    `\n${line}\n  📱 SMS (stub)  id=${msg.id}\n  To:   ${msg.to}\n  Body: ${msg.body}\n${line}`
  );
}

module.exports = {
  name: 'stub',

  async send({ to, body }) {
    if (!E164.test(String(to || ''))) {
      return { success: false, error: `Invalid destination number '${to}' (expected E.164)` };
    }
    if (String(to).endsWith('0000')) {
      return { success: false, error: 'Simulated carrier failure: destination unreachable (stub magic number)' };
    }
    const msg = { id: `SM_STUB_${crypto.randomUUID()}`, to, body, at: new Date().toISOString() };
    outbox.unshift(msg);
    outbox.length = Math.min(outbox.length, MAX_OUTBOX);
    printSms(msg);
    return { success: true, messageId: msg.id };
  },

  outbox: () => [...outbox],
  clearOutbox: () => {
    outbox.length = 0;
  },
};
