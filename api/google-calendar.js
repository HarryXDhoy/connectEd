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

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const identity = await requireSupabaseUser(req);
  if (identity.error) return json(res, identity.status, { error: identity.error });

  const {
    googleAccessToken,
    applicationId,
    projectId,
    title,
    startsAt,
    endsAt,
    notes = '',
    attendeeEmail = ''
  } = req.body || {};

  if (
    !googleAccessToken ||
    !validUuid(applicationId) ||
    !validUuid(projectId) ||
    !String(title || '').trim()
  ) {
    return json(res, 400, { error: 'Missing or invalid interview details.' });
  }

  const start = validDate(startsAt);
  const end = validDate(endsAt);
  const duration = start && end ? end.getTime() - start.getTime() : 0;
  if (!start || !end || start.getTime() < Date.now() - 60000 || duration < 900000 || duration > 10800000) {
    return json(res, 400, { error: 'Choose a future interview lasting 15 minutes to 3 hours.' });
  }

  if (
    attendeeEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendeeEmail)
  ) {
    return json(res, 400, { error: 'Enter a valid attendee email.' });
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

  const event = {
    summary: String(title).trim().slice(0, 120),
    description: String(notes).trim().slice(0, 2000) || 'Interview scheduled through connectEd',
    start: { dateTime: start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: end.toISOString(), timeZone: 'UTC' },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
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
        authorization: `Bearer ${googleAccessToken}`,
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
