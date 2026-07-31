import crypto from 'node:crypto';
import { json } from './_supabase.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifyStripeSignature(payload, signature, secret) {
  const pairs = String(signature || '')
    .split(',')
    .map(part => part.split('='))
    .filter(pair => pair.length === 2);
  const timestamp = pairs.find(([key]) => key === 't')?.[1];
  const signatures = pairs.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  return signatures.some(value => {
    // Compare the decoded bytes, not the strings. timingSafeEqual throws
    // outright on a length mismatch, and a JS string length is a UTF-16 code
    // unit count — for a non-hex signature containing multi-byte characters
    // the two can agree while the buffers differ in size, turning a bad
    // signature from "return false" into an uncaught throw.
    const candidate = Buffer.from(value, 'hex');
    const digest = Buffer.from(expected, 'hex');
    if (candidate.length !== digest.length || candidate.length === 0) return false;
    return crypto.timingSafeEqual(digest, candidate);
  });
}

async function supabaseWrite(path, body, method = 'POST') {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase server credentials are not configured.');
  }
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer: method === 'POST' ? 'resolution=merge-duplicates' : 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Supabase write failed with ${response.status}.`);
}

async function supabaseRead(path) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase server credentials are not configured.');
  }
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Supabase read failed with ${response.status}.`);
  return response.json();
}

async function activatePlus({
  userId,
  customerId,
  subscriptionId,
  projectId,
  active,
  periodEnd
}) {
  await supabaseWrite(
    `profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      priority_match_active: active,
      stripe_customer_id: customerId || null,
      stripe_subscription_id: subscriptionId || null
    },
    'PATCH'
  );

  const entitlement = {
    active,
    stripe_customer_id: customerId || null,
    stripe_subscription_id: subscriptionId || null,
    ends_at: periodEnd || null
  };
  // Only checkout knows which project was chosen. On subscription events the
  // entitlement row is the source of truth for that (see below), so don't let
  // a stale value from Stripe metadata overwrite it.
  if (projectId) entitlement.project_id = projectId;

  await supabaseWrite(
    `billing_entitlements?user_id=eq.${encodeURIComponent(userId)}&plan=eq.priority_match`,
    entitlement,
    'PATCH'
  );

  if (active && projectId) {
    await supabaseWrite(
      `projects?id=eq.${encodeURIComponent(projectId)}&owner_id=eq.${encodeURIComponent(userId)}`,
      { boost_until: periodEnd || new Date(Date.now() + 31 * 86400000).toISOString() },
      'PATCH'
    );
    return;
  }

  // Deactivation used to stop after flipping the two `active` flags, leaving
  // boost_until set as much as 31 days out with nothing on the platform able
  // to clear it: activate_plus_boost() only clears the owner's *other*
  // projects, the column is deliberately absent from every client grant, and
  // there is no expiry job. A cancelled subscriber kept their paid placement
  // until the date passed — and, because discovery ordered on the raw column,
  // kept outranking every unboosted project even after that.
  if (!active) {
    await supabaseWrite(
      `projects?owner_id=eq.${encodeURIComponent(userId)}&boost_until=not.is.null`,
      { boost_until: null },
      'PATCH'
    );
  }
}

// The boosted project is chosen at checkout, but the member can move it later
// through activate_plus_boost(). Stripe's subscription metadata is frozen at
// checkout time, so reading the target from there on a renewal re-boosted the
// original project and left two boosted at once. The entitlement row is the
// only thing that tracks the current choice.
async function currentBoostProject(userId) {
  const rows = await supabaseRead(
    `billing_entitlements?select=project_id&user_id=eq.${encodeURIComponent(userId)}&plan=eq.priority_match&limit=1`
  );
  return rows[0]?.project_id || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  // Everything up to the signature check used to run outside any try/catch —
  // the only handler in api/ that could return a non-JSON body. Reading the
  // request stream throws on an aborted upload, and the HMAC path throws on a
  // malformed signature header, both from an unauthenticated caller.
  let event;
  try {
    const payload = await rawBody(req);
    const signature = req.headers['stripe-signature'];
    if (
      !process.env.STRIPE_WEBHOOK_SECRET ||
      !verifyStripeSignature(payload.toString(), signature, process.env.STRIPE_WEBHOOK_SECRET)
    ) {
      return json(res, 400, { error: 'Invalid Stripe signature.' });
    }
    event = JSON.parse(payload.toString());
  } catch (error) {
    console.error('Stripe webhook could not be read or verified:', error.message);
    return json(res, 400, { error: 'Invalid webhook payload.' });
  }

  try {
    const object = event.data?.object || {};
    if (event.type === 'checkout.session.completed' && object.metadata?.plan === 'priority_match') {
      const userId = object.metadata.user_id;
      if (!userId) throw new Error('Webhook is missing user metadata.');
      // Stripe can and does redeliver this event (timeout, non-2xx, etc.),
      // and this handler must be idempotent — on_conflict targets the
      // (user_id, plan) unique constraint so a retry updates the existing
      // row via merge-duplicates instead of inserting a second one.
      await supabaseWrite('billing_entitlements?on_conflict=user_id,plan', {
        user_id: userId,
        plan: 'priority_match',
        stripe_customer_id: object.customer || null,
        stripe_subscription_id: object.subscription || null,
        project_id: object.metadata.project_id || null,
        active: true
      });
      await activatePlus({
        userId,
        customerId: object.customer,
        subscriptionId: object.subscription,
        projectId: object.metadata.project_id,
        active: true,
        periodEnd: null
      });
    }

    if (['customer.subscription.deleted', 'customer.subscription.updated'].includes(event.type)) {
      const active = ['active', 'trialing'].includes(object.status);
      const periodEnd = object.current_period_end
        ? new Date(object.current_period_end * 1000).toISOString()
        : null;
      if (object.metadata?.user_id && object.metadata?.plan === 'priority_match') {
        await activatePlus({
          userId: object.metadata.user_id,
          customerId: object.customer,
          subscriptionId: object.id,
          projectId: active ? await currentBoostProject(object.metadata.user_id) : '',
          active,
          periodEnd
        });
      }
    }
  } catch (error) {
    console.error('Stripe webhook processing failed:', error.message);
    return json(res, 500, { error: 'Webhook processing failed.' });
  }

  return json(res, 200, { received: true });
}
