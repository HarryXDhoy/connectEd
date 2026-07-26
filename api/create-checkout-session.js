import {
  json,
  requireSupabaseUser,
  userQuery,
  validUuid
} from './_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const identity = await requireSupabaseUser(req);
  if (identity.error) return json(res, identity.status, { error: identity.error });

  const { plan = '', projectId = '' } = req.body || {};
  if (plan !== 'connected_plus') return json(res, 400, { error: 'Unknown plan.' });

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRIORITY_PRICE_ID) {
    return json(res, 503, { error: 'Payments are not configured yet.' });
  }

  let ownedProjectId = '';
  if (projectId) {
    if (!validUuid(projectId)) return json(res, 400, { error: 'Invalid project.' });
    const projectResponse = await userQuery(
      `projects?select=id&id=eq.${encodeURIComponent(projectId)}&owner_id=eq.${identity.user.id}&limit=1`,
      identity.token
    );
    const projects = projectResponse.ok ? await projectResponse.json() : [];
    if (!projects.length) return json(res, 403, { error: 'You can only boost your own project.' });
    ownedProjectId = projects[0].id;
  }

  const siteUrl = process.env.PUBLIC_SITE_URL || 'https://cntd-projects.vercel.app';
  const params = new URLSearchParams({
    mode: 'subscription',
    success_url: `${siteUrl}/project-hub.html?checkout=success`,
    cancel_url: `${siteUrl}/project-hub.html?checkout=cancelled`,
    'line_items[0][price]': process.env.STRIPE_PRIORITY_PRICE_ID,
    'line_items[0][quantity]': '1',
    'metadata[plan]': 'priority_match',
    'metadata[user_id]': identity.user.id,
    'metadata[project_id]': ownedProjectId,
    'subscription_data[metadata][plan]': 'priority_match',
    'subscription_data[metadata][user_id]': identity.user.id,
    'subscription_data[metadata][project_id]': ownedProjectId,
    customer_email: identity.user.email || ''
  });

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  const data = await response.json();
  if (!response.ok) {
    return json(res, response.status, {
      error: data.error?.message || 'Stripe could not create checkout.'
    });
  }
  return json(res, 200, { url: data.url, sessionId: data.id });
}
