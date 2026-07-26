import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const config = window.CONNECTED_CONFIG || {};
const configured = Boolean(
  config.url &&
  config.anonKey &&
  !config.url.includes('YOUR_') &&
  !config.anonKey.includes('YOUR_')
);

export const supabase = configured
  ? createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

export const isSupabaseConfigured = configured;

export async function getSession() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session || null;
}

export async function currentUser() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user || null;
}

export async function authHeaders() {
  const session = await getSession();
  if (!session?.access_token) throw new Error('Sign in to continue.');
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${session.access_token}`
  };
}

export async function signInWithGoogle(returnPath = '/project-hub.html') {
  if (!supabase) throw new Error('Supabase is not configured yet.');
  const redirectTo = new URL(returnPath, window.location.origin).toString();
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent'
      },
      scopes: 'https://www.googleapis.com/auth/calendar.events'
    }
  });
}

export async function signInWithPassword(email, password) {
  if (!supabase) throw new Error('Supabase is not configured yet.');
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signUpWithPassword(email, password, displayName) {
  if (!supabase) throw new Error('Supabase is not configured yet.');
  return supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: displayName },
      emailRedirectTo: new URL('/project-hub.html', window.location.origin).toString()
    }
  });
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
