import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const config = window.CONNECTED_CONFIG || {};
const configured = Boolean(config.url && config.anonKey && !config.url.includes('YOUR_') && !config.anonKey.includes('YOUR_'));
export const supabase = configured ? createClient(config.url, config.anonKey) : null;
export const isSupabaseConfigured = configured;

export async function currentUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data.user || null;
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error('Supabase is not configured yet.');
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.href,
      queryParams: { access_type: 'offline', prompt: 'consent' },
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
  return supabase.auth.signUp({ email, password, options: { data: { full_name: displayName } } });
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
