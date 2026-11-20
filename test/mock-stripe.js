// A stand-in for the three Stripe Checkout endpoints the shop uses, so the
// tests can run the whole buy flow offline with no Stripe account.

import http from 'node:http';
import crypto from 'node:crypto';

export function startMockStripe(port = 0) {
  const sessions = new Map();
  const calls = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method: req.method, url: req.url, params, headers: req.headers });
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const notFound = () => send(404, { error: { type: 'invalid_request_error', message: 'No such checkout.session' } });
      let m;
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        n += 1;
        const id = `cs_test_mock_${n}`;
        const s = {
          id, object: 'checkout.session', url: `https://checkout.stripe.test/${id}`, status: 'open', payment_status: 'unpaid',
          metadata: { order_id: params['metadata[order_id]'] }, amount_total: null, customer_details: null,
        };
        sessions.set(id, s);
        return send(200, s);
      }
      if (req.method === 'GET' && (m = req.url.match(/^\/v1\/checkout\/sessions\/([^/?]+)/))) {
        const s = sessions.get(m[1]);
        return s ? send(200, s) : notFound();
      }
      if (req.method === 'POST' && (m = req.url.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) {
        const s = sessions.get(m[1]);
        if (!s) return notFound();
        if (s.status !== 'open') return send(400, { error: { type: 'invalid_request_error', message: 'Only Checkout Sessions with a status of open can be expired.' } });
        s.status = 'expired';
        return send(200, s);
      }
      send(404, { error: { type: 'invalid_request_error', message: `mock: unhandled ${req.method} ${req.url}` } });
    });
  });

  // Simulate the buyer finishing payment on Stripe's page.
  function pay(id, { total, shipping = 800, async = false } = {}) {
    const s = sessions.get(id);
    s.status = 'complete';
    s.payment_status = async ? 'unpaid' : 'paid';
    s.amount_total = total;
    s.shipping_cost = { amount_total: shipping };
    s.customer_details = { name: 'Jane Buyer', email: 'jane@example.com', phone: '+15555550123', address: { line1: '1 Billing Rd', city: 'Elsewhere', state: 'CA', postal_code: '90001', country: 'US' } };
    s.collected_information = {
      shipping_details: { name: 'Jane Buyer', address: { line1: '123 Main St', line2: 'Apt 4', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } },
    };
    return s;
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${server.address().port}`, sessions, calls, pay, close: () => server.close() }));
  });
}

// Signs a webhook payload the way Stripe does.
export function stripeSignature(payload, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
