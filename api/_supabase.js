const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://josrjdvcdkqkwfzomxxh.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_HWbWWjReEesgL3JrSSalwQ_uzPLpzAi';

export function json(res, status, body) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

export function bearerToken(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

export async function requireSupabaseUser(req) {
  const token = bearerToken(req);
  if (!token) return { error: 'Authentication required.', status: 401 };

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) return { error: 'Your session is invalid or expired.', status: 401 };
  return { user: await response.json(), token };
}

export async function userQuery(path, token) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`,
      accept: 'application/json'
    }
  });
}

export function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}
