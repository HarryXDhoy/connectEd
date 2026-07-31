import {
  json,
  requireSupabaseUser,
  userQuery,
  validUuid
} from './_supabase.js';

// This handler chains several external calls (Supabase + Google) even
// after parallelizing what can run concurrently — worth a longer budget
// than the platform default where the plan allows it. Ignored on plans
// that cap function duration below this regardless.
export const config = { maxDuration: 30 };

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

// google_event_id, meet_url and calendar_html_link are no longer writable by
// the client (see the 20260731090000 migration): they are Google's values, and
// letting an organizer choose them meant they could point the candidate's
// "Open Meet" button anywhere they liked. The row is written here instead,
// with the service role, after this handler has already verified that the
// caller owns the project and that the application belongs to it.
async function saveInterview(row) {
  const url = process.env.SUPABASE_URL || 'https://josrjdvcdkqkwfzomxxh.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return { error: 'unconfigured' };
  const response = await fetch(`${url}/rest/v1/interviews`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      prefer: 'return=representation'
    },
    body: JSON.stringify(row)
  });
  if (!response.ok) return { error: `write_failed_${response.status}` };
  const rows = await response.json();
  return { interview: rows[0] || null };
}

// Every successful call sends a real calendar invite to the candidate's inbox
// (sendUpdates=all), and nothing stopped an owner from calling it in a loop —
// an accepted applicant could be buried under invites by someone whose only
// qualification was owning a project they once applied to. Interviews are
// recorded here, so the table itself is the rate limit: a handful of genuine
// reschedules a day is normal, hundreds is not.
const INTERVIEWS_PER_APPLICATION_PER_DAY = 5;

async function recentInterviewCount(applicationId) {
  const url = process.env.SUPABASE_URL || 'https://josrjdvcdkqkwfzomxxh.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return 0;
  const since = new Date(Date.now() - 86400000).toISOString();
  const response = await fetch(
    `${url}/rest/v1/interviews?select=id&application_id=eq.${applicationId}&created_at=gte.${since}`,
    {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        accept: 'application/json',
        // Ask for the count in a header rather than pulling every row back.
        prefer: 'count=exact',
        range: '0-0'
      }
    }
  );
  if (!response.ok) return 0;
  const contentRange = response.headers.get('content-range') || '';
  const total = Number(contentRange.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

// The calendar event is created before the row exists, so a failed write used
// to leave a real event on the organizer's calendar and a real invite in the
// candidate's inbox that the app had no record of — invisible to both the
// applicant list and the agenda, and impossible to cancel from the UI. Undo
// the half that did land instead of leaving the two out of step.
async function deleteCalendarEvent(accessToken, eventId) {
  if (!eventId) return;
  try {
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } }
    );
  } catch (error) {
    // Best effort: the caller is already on an error path and the useful
    // thing to report is the original failure, not this one.
    console.error('failed to roll back calendar event:', error);
  }
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

// Reads the interview together with the project that owns it, so the caller's
// right to touch it can be checked in one round trip. Service role, because
// the columns being changed are no longer client-writable.
async function ownedInterview(interviewId, ownerId) {
  const url = process.env.SUPABASE_URL || 'https://josrjdvcdkqkwfzomxxh.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return { error: 'unconfigured' };
  const response = await fetch(
    `${url}/rest/v1/interviews?select=id,google_event_id,organizer_id,application_id&id=eq.${interviewId}&organizer_id=eq.${ownerId}&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        accept: 'application/json'
      }
    }
  );
  if (!response.ok) return { error: 'lookup_failed' };
  const rows = await response.json();
  return rows.length ? { interview: rows[0] } : { error: 'not_found' };
}

async function writeInterview(interviewId, patch, method = 'PATCH') {
  const url = process.env.SUPABASE_URL || 'https://josrjdvcdkqkwfzomxxh.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return { error: 'unconfigured' };
  const response = await fetch(`${url}/rest/v1/interviews?id=eq.${interviewId}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    ...(method === 'PATCH' ? { body: JSON.stringify(patch) } : {})
  });
  return response.ok ? {} : { error: `write_failed_${response.status}` };
}

// A scheduled interview could not be changed or cancelled from anywhere in the
// app — no .update() or .delete() on interviews existed in the client at all,
// and openInterview() simply refused with "An interview is already scheduled
// for this application." The only way out was for the owner to decline the
// applicant outright.
async function cancelInterview(req, res, identity) {
  const { interviewId } = req.body || {};
  if (!validUuid(interviewId)) return json(res, 400, { error: 'Invalid interview.' });

  const owned = await ownedInterview(interviewId, identity.user.id);
  if (owned.error === 'not_found') {
    return json(res, 403, { error: 'Only the organizer can cancel this interview.' });
  }
  if (owned.error) return json(res, 500, { error: 'The interview could not be looked up.' });

  const tokenResult = await organizerGoogleAccessToken(identity.user.id);
  // Removing the row is the part that matters — if Google is unreachable the
  // app must not be left showing an interview it believes is cancelled.
  if (!tokenResult.error) {
    await deleteCalendarEvent(tokenResult.accessToken, owned.interview.google_event_id);
  }
  const removed = await writeInterview(interviewId, null, 'DELETE');
  if (removed.error) return json(res, 500, { error: 'The interview could not be cancelled. Please try again.' });

  return json(res, 200, {
    cancelled: true,
    calendarEventRemoved: !tokenResult.error,
    applicationId: owned.interview.application_id
  });
}

async function rescheduleInterview(req, res, identity) {
  const { interviewId, startsAt, endsAt, title, notes = '' } = req.body || {};
  if (!validUuid(interviewId)) return json(res, 400, { error: 'Invalid interview.' });

  const start = validDate(startsAt);
  const end = validDate(endsAt);
  const duration = start && end ? end.getTime() - start.getTime() : 0;
  if (!start || !end || start.getTime() < Date.now() - 60000 || duration < 900000 || duration > 10800000) {
    return json(res, 400, { error: 'Choose a future interview lasting 15 minutes to 3 hours.' });
  }
  if (!String(title || '').trim()) return json(res, 400, { error: 'Missing or invalid interview details.' });

  const owned = await ownedInterview(interviewId, identity.user.id);
  if (owned.error === 'not_found') {
    return json(res, 403, { error: 'Only the organizer can reschedule this interview.' });
  }
  if (owned.error) return json(res, 500, { error: 'The interview could not be looked up.' });

  const tokenResult = await organizerGoogleAccessToken(identity.user.id);
  if (tokenResult.error) {
    return json(res, 401, {
      error: 'Google Calendar access could not be refreshed. Reconnect Google and try again.',
      needsGoogleReconnect: true
    });
  }

  // PATCH the existing event rather than creating a new one: the attendee
  // keeps the same Meet link and gets an update, not a second invitation to a
  // meeting they already have.
  const patched = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(owned.interview.google_event_id)}?sendUpdates=all`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${tokenResult.accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        summary: String(title).trim().slice(0, 120),
        description: String(notes).trim().slice(0, 2000) || 'Interview scheduled through connectEd',
        start: { dateTime: start.toISOString(), timeZone: 'UTC' },
        end: { dateTime: end.toISOString(), timeZone: 'UTC' }
      })
    }
  );
  const patchData = await patched.json();
  if (!patched.ok) {
    return json(res, patched.status, {
      error: patchData.error?.message || 'Google Calendar could not update the event.'
    });
  }

  const saved = await writeInterview(interviewId, {
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    title: String(title).trim().slice(0, 120),
    notes: String(notes).trim().slice(0, 2000)
  });
  if (saved.error) {
    return json(res, 500, { error: 'The calendar event moved, but the interview record could not be updated.' });
  }

  return json(res, 200, { rescheduled: true, htmlLink: patchData.htmlLink });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const mode = String(req.body?.mode || 'create');
      if (mode === 'cancel' || mode === 'reschedule') {
        const identity = await requireSupabaseUser(req);
        if (identity.error) return json(res, identity.status, { error: identity.error });
        return mode === 'cancel'
          ? await cancelInterview(req, res, identity)
          : await rescheduleInterview(req, res, identity);
      }
    }
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

  // This handler used to run every external call one after another —
  // project lookup, application lookup, candidate email lookup, profile
  // lookup, OAuth token refresh, then the Calendar API itself — six
  // sequential round trips. On a slow network that's enough to blow past
  // the platform's function timeout, which kills the process before it
  // can send any response at all (not something a try/catch inside the
  // function can intercept). organizerGoogleAccessToken() only needs
  // identity.user.id, already known this early, so it starts immediately
  // and runs concurrently with everything else instead of waiting its turn.
  const tokenPromise = organizerGoogleAccessToken(identity.user.id);

  const [projectResponse, applicationResponse] = await Promise.all([
    userQuery(
      `projects?select=id,owner_id&id=eq.${projectId}&owner_id=eq.${identity.user.id}&limit=1`,
      identity.token
    ),
    userQuery(
      `applications?select=id,project_id,applicant_id,status&id=eq.${applicationId}&project_id=eq.${projectId}&limit=1`,
      identity.token
    )
  ]);
  const projects = projectResponse.ok ? await projectResponse.json() : [];
  if (!projects.length) return json(res, 403, { error: 'Only the project owner can schedule interviews.' });

  const applications = applicationResponse.ok ? await applicationResponse.json() : [];
  if (!applications.length) return json(res, 403, { error: 'Application does not belong to this project.' });
  if (!['pending', 'accepted', 'interview'].includes(applications[0].status)) {
    return json(res, 409, { error: 'Interviews cannot be scheduled for a declined or withdrawn application.' });
  }

  if (!String(title || '').trim()) {
    return json(res, 400, { error: 'Missing or invalid interview details.' });
  }

  const start = validDate(startsAt);
  const end = validDate(endsAt);
  const duration = start && end ? end.getTime() - start.getTime() : 0;
  if (!start || !end || start.getTime() < Date.now() - 60000 || duration < 900000 || duration > 10800000) {
    return json(res, 400, { error: 'Choose a future interview lasting 15 minutes to 3 hours.' });
  }

  // tokenPromise has had a head start since before the Promise.all above —
  // this now overlaps with whatever's left of it instead of waiting for it
  // to finish first.
  const [{ email: accountEmail, reason: lookupIssue }, tokenResult] = await Promise.all([
    candidateEmail(applications[0].applicant_id),
    tokenPromise
  ]);
  const resolvedEmail = accountEmail || String(attendeeEmail).trim();
  if (!resolvedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resolvedEmail)) {
    const detail = lookupIssue === 'unconfigured'
      ? 'The server is missing SUPABASE_SERVICE_ROLE_KEY, so it could not look up the candidate’s account email.'
      : lookupIssue === 'lookup_failed'
        ? 'The candidate’s account email lookup failed.'
        : 'The candidate has no email on file.';
    return json(res, 400, { error: `Candidate email is unavailable or invalid. ${detail} Enter it manually to continue.` });
  }

  if (await recentInterviewCount(applicationId) >= INTERVIEWS_PER_APPLICATION_PER_DAY) {
    return json(res, 429, {
      error: 'Too many interviews scheduled for this application today. Try again tomorrow.'
    });
  }

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

  const meetUrl = data.conferenceData?.entryPoints?.find(
    entry => entry.entryPointType === 'video'
  )?.uri || null;
  // Google can return 200 with the event created but the Meet room itself
  // failed (createRequest.status.statusCode !== 'success') — meetUrl ends
  // up null either way, so without this the caller can't tell "no video
  // call was requested" apart from "one was requested and failed."
  const conferenceStatus = data.conferenceData?.createRequest?.status?.statusCode;
  const meetLinkFailed = !meetUrl && conferenceStatus && conferenceStatus !== 'success';

  const saved = await saveInterview({
    project_id: projectId,
    application_id: applicationId,
    organizer_id: identity.user.id,
    // Server-verified, not whatever the client claimed the candidate was.
    candidate_id: applications[0].applicant_id,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    title: String(title).trim().slice(0, 120),
    notes: String(notes).trim().slice(0, 2000),
    google_event_id: data.id,
    meet_url: meetUrl,
    calendar_html_link: data.htmlLink || null
  });

  if (saved.error) {
    await deleteCalendarEvent(tokenResult.accessToken, data.id);
    const message = saved.error === 'unconfigured'
      ? 'The server is missing SUPABASE_SERVICE_ROLE_KEY, so the interview could not be recorded.'
      : 'The interview could not be saved, so the calendar invite was cancelled. Please try again.';
    return json(res, 500, { error: message });
  }

  return json(res, 200, {
    eventId: data.id,
    htmlLink: data.htmlLink,
    meetUrl,
    meetLinkFailed,
    candidateId: applications[0].applicant_id,
    interview: saved.interview
  });
}
