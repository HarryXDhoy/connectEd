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
    if (value.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(value));
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

  await supabaseWrite(
    `billing_entitlements?user_id=eq.${encodeURIComponent(userId)}&plan=eq.priority_match`,
    {
      active,
      stripe_customer_id: customerId || null,
      stripe_subscription_id: subscriptionId || null,
      project_id: projectId || null,
      ends_at: periodEnd || null
    },
    'PATCH'
  );

  if (active && projectId) {
    await supabaseWrite(
      `projects?id=eq.${encodeURIComponent(projectId)}&owner_id=eq.${encodeURIComponent(userId)}`,
      { boost_until: periodEnd || new Date(Date.now() + 31 * 86400000).toISOString() },
      'PATCH'
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const payload = await rawBody(req);
  const signature = req.headers['stripe-signature'];
  if (
    !process.env.STRIPE_WEBHOOK_SECRET ||
    !verifyStripeSignature(payload.toString(), signature, process.env.STRIPE_WEBHOOK_SECRET)
  ) {
    return json(res, 400, { error: 'Invalid Stripe signature.' });
  }

  let event;
  try {
    event = JSON.parse(payload.toString());
  } catch {
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
          projectId: object.metadata.project_id,
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
