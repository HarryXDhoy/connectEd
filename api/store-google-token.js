import { json, requireSupabaseUser } from './_supabase.js';

// Called once, right after a Google sign-in that granted Calendar access.
// The refresh token is long-lived, so storing it here means the interview
// scheduler never has to send the user back through Google sign-in just
// because their short-lived access token expired.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const identity = await requireSupabaseUser(req);
  if (identity.error) return json(res, identity.status, { error: identity.error });

  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return json(res, 400, { error: 'Missing refresh token.' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(res, 503, { error: 'Server is not configured to store Google credentials.' });
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${identity.user.id}`,
    {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        prefer: 'return=minimal'
      },
      body: JSON.stringify({ google_refresh_token: refreshToken })
    }
  );
  if (!response.ok) return json(res, 502, { error: 'Google credentials could not be stored.' });

  return json(res, 200, { stored: true });
}
