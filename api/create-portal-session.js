import { json, requireSupabaseUser } from './_supabase.js';

// stripe_customer_id is deliberately hidden from the profiles column grant
// (see the initial schema migration) — it's only ever readable here, with
// the service role, never by the client directly.
export default async function handler(req, res) {
  try {
    return await createPortalSession(req, res);
  } catch (error) {
    console.error('create-portal-session handler failed:', error);
    return json(res, 500, { error: 'Billing management could not be opened. Please try again.' });
  }
}

async function createPortalSession(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const identity = await requireSupabaseUser(req);
  if (identity.error) return json(res, identity.status, { error: identity.error });

  if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(res, 503, { error: 'Billing management is not configured yet.' });
  }

  const profileResponse = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?select=stripe_customer_id&id=eq.${identity.user.id}&limit=1`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: 'application/json'
      }
    }
  );
  const profiles = profileResponse.ok ? await profileResponse.json() : [];
  const customerId = profiles[0]?.stripe_customer_id;
  if (!customerId) return json(res, 404, { error: 'No billing account found yet — subscribe first.' });

  const siteUrl = process.env.PUBLIC_SITE_URL || 'https://cntd-projects.vercel.app';
  const params = new URLSearchParams({
    customer: customerId,
    return_url: `${siteUrl}/project-hub.html`
  });

  const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
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
      error: data.error?.message || 'Stripe could not open the billing portal.'
    });
  }
  return json(res, 200, { url: data.url });
}
