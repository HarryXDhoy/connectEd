export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { plan = 'project_boost', email = '', projectId = '', userId = '' } = req.body || {};
  const priceId = plan === 'priority_match' ? process.env.STRIPE_PRIORITY_PRICE_ID : plan === 'team' ? process.env.STRIPE_TEAM_PRICE_ID : process.env.STRIPE_BOOST_PRICE_ID;
  if (!process.env.STRIPE_SECRET_KEY || !priceId) return res.status(503).json({ error: 'Stripe is not configured yet.' });
  const params = new URLSearchParams({
    mode: ['priority_match', 'team'].includes(plan) ? 'subscription' : 'payment',
    success_url: `${process.env.PUBLIC_SITE_URL || 'https://cntd-projects.vercel.app'}/project-hub.html?checkout=success`,
    cancel_url: `${process.env.PUBLIC_SITE_URL || 'https://cntd-projects.vercel.app'}/project-hub.html?checkout=cancelled`,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'metadata[plan]': plan,
    'metadata[user_id]': userId,
    'metadata[project_id]': projectId
  });
  if (['priority_match', 'team'].includes(plan)) {
    params.set('subscription_data[metadata][plan]', plan);
    params.set('subscription_data[metadata][user_id]', userId);
  }
  if (email) params.set('customer_email', email);
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const data = await response.json();
  if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Stripe could not create checkout.' });
  return res.status(200).json({ url: data.url, sessionId: data.id });
}
