import {
  json,
  requireSupabaseUser,
  userQuery,
  validUuid
} from './_supabase.js';

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// Server-verified email for the candidate, independent of whatever the
// client sent — falls back to the client-supplied value only if the
// service-role lookup is unavailable.
async function candidateEmail(userId) {
  const url = process.env.SUPABASE_URL || 'https://josrjdvcdkqkwfzomxxh.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Distinguish "not configured" from "looked up and found nothing" so the
  // caller can explain which one actually happened.
  if (!serviceRoleKey) return { email: '', reason: 'unconfigured' };
  const response = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`
    }
  });
  if (!response.ok) return { email: '', reason: 'lookup_failed' };
  const candidate = await response.json();
  return { email: String(candidate.email || '').trim(), reason: '' };
}

// Google access tokens expire in about an hour and Supabase never hands us
// a fresh one after the initial sign-in redirect, so the organizer's stored
// refresh token (captured once, at sign-in — see api/store-google-token.js)
// is exchanged for a new access token on every request instead.
async function organizerGoogleAccessToken(userId) {
  const url = process.env.SUPABASE_URL || 'https://josrjdvcdkqkwfzomxxh.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return { error: 'unconfigured' };

  const profileResponse = await fetch(
    `${url}/rest/v1/profiles?select=google_refresh_token&id=eq.${userId}&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );
  if (!profileResponse.ok) return { error: 'lookup_failed' };
  const rows = await profileResponse.json();
  const refreshToken = rows[0]?.google_refresh_token;
  if (!refreshToken) return { error: 'not_connected' };

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return { error: 'unconfigured' };
  }
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!tokenResponse.ok) return { error: 'refresh_failed' };
  const tokenData = await tokenResponse.json();
  return { accessToken: tokenData.access_token };
}

export default async function handler(req, res) {
  try {
    return await scheduleInterview(req, res);
  } catch (error) {
    // This handler chains four sequential external calls (candidate email
    // lookup, profile lookup, Google OAuth token refresh, then the Calendar
    // API itself) with nothing catching a failure in any of them — a
    // timeout, network blip, or unexpected Google response used to crash
    // the function uncaught, which Vercel turns into an empty/non-JSON
    // body. The frontend's response.json() then throws "Unexpected end of
    // JSON input", a meaningless error to show someone scheduling an
    // interview. Every path now returns real JSON, even this one.
    console.error('google-calendar handler failed:', error);
    return json(res, 500, { error: 'Something went wrong creating the calendar event. Please try again.' });
  }
}

async function scheduleInterview(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const identity = await requireSupabaseUser(req);
  if (identity.error) return json(res, identity.status, { error: identity.error });

  const {
    applicationId,
    projectId,
    title,
    startsAt,
    endsAt,
    notes = '',
    attendeeEmail = ''
  } = req.body || {};

  if (!validUuid(applicationId) || !validUuid(projectId)) {
    return json(res, 400, { error: 'Missing or invalid interview details.' });
  }

  const projectResponse = await userQuery(
    `projects?select=id,owner_id&id=eq.${projectId}&owner_id=eq.${identity.user.id}&limit=1`,
    identity.token
  );
  const projects = projectResponse.ok ? await projectResponse.json() : [];
  if (!projects.length) return json(res, 403, { error: 'Only the project owner can schedule interviews.' });

  const applicationResponse = await userQuery(
    `applications?select=id,project_id,applicant_id&id=eq.${applicationId}&project_id=eq.${projectId}&limit=1`,
    identity.token
  );
  const applications = applicationResponse.ok ? await applicationResponse.json() : [];
  if (!applications.length) return json(res, 403, { error: 'Application does not belong to this project.' });

  if (!String(title || '').trim()) {
    return json(res, 400, { error: 'Missing or invalid interview details.' });
  }

  const start = validDate(startsAt);
  const end = validDate(endsAt);
  const duration = start && end ? end.getTime() - start.getTime() : 0;
  if (!start || !end || start.getTime() < Date.now() - 60000 || duration < 900000 || duration > 10800000) {
    return json(res, 400, { error: 'Choose a future interview lasting 15 minutes to 3 hours.' });
  }

  const { email: accountEmail, reason: lookupIssue } = await candidateEmail(applications[0].applicant_id);
  const resolvedEmail = accountEmail || String(attendeeEmail).trim();
  if (!resolvedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resolvedEmail)) {
    const detail = lookupIssue === 'unconfigured'
      ? 'The server is missing SUPABASE_SERVICE_ROLE_KEY, so it could not look up the candidate’s account email.'
      : lookupIssue === 'lookup_failed'
        ? 'The candidate’s account email lookup failed.'
        : 'The candidate has no email on file.';
    return json(res, 400, { error: `Candidate email is unavailable or invalid. ${detail} Enter it manually to continue.` });
  }

  const tokenResult = await organizerGoogleAccessToken(identity.user.id);
  if (tokenResult.error) {
    const message = tokenResult.error === 'not_connected'
      ? 'Connect Google Calendar to schedule interviews — sign in with Google once, and we will not ask again.'
      : tokenResult.error === 'unconfigured'
        ? 'Google Calendar is not configured on the server yet.'
        : 'Google Calendar access could not be refreshed. Reconnect Google and try again.';
    return json(res, 401, { error: message, needsGoogleReconnect: true });
  }

  const event = {
    summary: String(title).trim().slice(0, 120),
    description: String(notes).trim().slice(0, 2000) || 'Interview scheduled through connectEd',
    start: { dateTime: start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: end.toISOString(), timeZone: 'UTC' },
    attendees: [{ email: resolvedEmail }],
    conferenceData: {
      createRequest: {
        requestId: `connected-${applicationId}-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };

  const response = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenResult.accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(event)
    }
  );
  const data = await response.json();
  if (!response.ok) {
    return json(res, response.status, {
      error: data.error?.message || 'Google Calendar request failed.'
    });
  }

  return json(res, 200, {
    eventId: data.id,
    htmlLink: data.htmlLink,
    meetUrl:
      data.conferenceData?.entryPoints?.find(
        entry => entry.entryPointType === 'video'
      )?.uri || null,
    candidateId: applications[0].applicant_id
  });
}
