// The three Stripe Checkout calls the shop needs, plus webhook signature
// checking, using plain fetch and Web Crypto (no SDK, so the Worker stays small).

const API_VERSION = '2026-11-18.endive';
const enc = new TextEncoder();

// Stripe's form encoding: { a: { b: [x] } } -> a[b][0]=x
function encodeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export class StripeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createStripe(secretKey, { apiBase = 'https://api.stripe.com' } = {}) {
  async function call(method, path, params, idempotencyKey) {
    const headers = {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': API_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const init = { method, headers, body: params ? encodeForm(params).join('&') : undefined };
    let res;
    try {
      res = await fetch(apiBase + path, init);
    } catch {
      res = await fetch(apiBase + path, init); // one retry on a network blip; all calls here are safe to repeat
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new StripeError((body.error && body.error.message) || `Stripe returned ${res.status}`, res.status);
    return body;
  }
  return {
    mode: /_live_/.test(secretKey) ? 'live' : 'test',
    createCheckoutSession: (params, idempotencyKey) => call('POST', '/v1/checkout/sessions', params, idempotencyKey),
    retrieveCheckoutSession: (id) => call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`),
    expireCheckoutSession: (id) => call('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`),
  };
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// Stripe-Signature: t=<unix seconds>,v1=<hex hmac of "t.payload">[,v1=...]
export async function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    if (k === 'v1') sigs.push(v);
  }
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const want = await hmacHex(secret, `${t}.${payload}`);
  return sigs.some((s) => timingSafeEqual(s, want));
}
