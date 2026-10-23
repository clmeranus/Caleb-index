'use strict';

// Government ID checks through Stripe Identity, using its REST API directly.
// https://docs.stripe.com/identity

const crypto = require('node:crypto');

const API = 'https://api.stripe.com/v1';

function stripeIdentity({ secretKey, fetchImpl = fetch }) {
  async function request(method, path, params) {
    const body = params && new URLSearchParams(params).toString();
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Stripe: ${(data.error && data.error.message) || res.status}`);
    return data;
  }

  return {
    // Starts a document + selfie check and returns the hosted page to send the member to.
    async createSession({ memberId, returnUrl }) {
      const session = await request('POST', '/identity/verification_sessions', {
        type: 'document',
        'options[document][require_matching_selfie]': 'true',
        'metadata[member_id]': String(memberId),
        return_url: returnUrl,
      });
      return { id: session.id, url: session.url };
    },

    // Returns the session's status and, once verified, the first name read from the ID.
    async getSession(id) {
      const session = await request(
        'GET',
        `/identity/verification_sessions/${encodeURIComponent(id)}?expand[]=verified_outputs`
      );
      return {
        id: session.id,
        status: session.status,
        firstName: session.verified_outputs ? session.verified_outputs.first_name : null,
      };
    },
  };
}

// Checks a Stripe-Signature header against the raw request body. Returns the parsed
// event, or throws if the signature is wrong or too old.
function verifyWebhook(rawBody, header, secret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const parts = Object.groupBy(String(header ?? '').split(','), (p) => p.split('=')[0]);
  const timestamp = Number(parts.t && parts.t[0].slice(2));
  const signatures = (parts.v1 || []).map((p) => p.slice(3));
  if (!timestamp || !signatures.length) throw new Error('Missing signature.');
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) throw new Error('Signature too old.');
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  );
  const valid = signatures.some((sig) => {
    const given = Buffer.from(sig);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!valid) throw new Error('Invalid signature.');
  return JSON.parse(rawBody);
}

function signWebhook(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

module.exports = { stripeIdentity, verifyWebhook, signWebhook };
