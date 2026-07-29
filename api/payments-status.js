import { json } from './_supabase.js';

// Public, unauthenticated on purpose — this reports nothing beyond a
// boolean, so the "Get connectEd Plus" button can hide itself instead of
// letting a visitor click through to a raw "Payments are not configured
// yet." error from create-checkout-session.
export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  const configured = Boolean(
    process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRIORITY_PRICE_ID
  );
  return json(res, 200, { configured });
}
