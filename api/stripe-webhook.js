import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifyStripeSignature(payload, signature, secret) {
  const parts = Object.fromEntries(signature.split(',').map(part => part.split('=')));
  const signed = `${parts.t}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  if (!parts.v1 || parts.v1.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

async function supabaseWrite(path, body, method = 'POST') {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(body)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const payload = await rawBody(req);
  const signature = req.headers['stripe-signature'];
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET || !verifyStripeSignature(payload.toString(), signature, process.env.STRIPE_WEBHOOK_SECRET)) return res.status(400).json({ error: 'Invalid Stripe signature.' });
  const event = JSON.parse(payload.toString());
  const object = event.data?.object || {};
  const metadata = object.metadata || {};
  if (event.type === 'checkout.session.completed') {
    const plan = metadata.plan;
    const userId = metadata.user_id;
    if (userId && plan === 'project_boost' && metadata.project_id) {
      await supabaseWrite('billing_entitlements', { user_id: userId, plan, project_id: metadata.project_id, active: true, ends_at: new Date(Date.now() + 7 * 86400000).toISOString() });
      await supabaseWrite(`projects?id=eq.${metadata.project_id}`, { boost_until: new Date(Date.now() + 7 * 86400000).toISOString() }, 'PATCH');
    }
    if (userId && ['priority_match', 'team'].includes(plan)) {
      await supabaseWrite('billing_entitlements', { user_id: userId, plan, stripe_customer_id: object.customer || null, stripe_subscription_id: object.subscription || null, active: true });
      if (plan === 'priority_match') await supabaseWrite(`profiles?id=eq.${userId}`, { priority_match_active: true, stripe_customer_id: object.customer || null, stripe_subscription_id: object.subscription || null }, 'PATCH');
    }
  }
  if (['customer.subscription.deleted', 'customer.subscription.updated'].includes(event.type)) {
    const subscription = object;
    await supabaseWrite(`billing_entitlements?stripe_subscription_id=eq.${subscription.id}`, { active: subscription.status === 'active' || subscription.status === 'trialing', ends_at: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null }, 'PATCH');
    if (subscription.metadata?.user_id && subscription.metadata?.plan === 'priority_match') {
      await supabaseWrite(`profiles?id=eq.${subscription.metadata.user_id}`, { priority_match_active: subscription.status === 'active' || subscription.status === 'trialing' }, 'PATCH');
    }
  }
  console.log(`Stripe event received: ${event.type}`);
  return res.status(200).json({ received: true });
}
