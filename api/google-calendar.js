export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { accessToken, title, startsAt, endsAt, notes, attendeeEmail } = req.body || {};
  if (!accessToken || !title || !startsAt || !endsAt) return res.status(400).json({ error: 'Missing calendar event details.' });
  const event = {
    summary: title,
    description: notes || 'Interview scheduled through connectEd',
    start: { dateTime: startsAt, timeZone: 'UTC' },
    end: { dateTime: endsAt, timeZone: 'UTC' },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    conferenceData: { createRequest: { requestId: `connected-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  };
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(event)
  });
  const data = await response.json();
  if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Google Calendar request failed.' });
  return res.status(200).json({ eventId: data.id, htmlLink: data.htmlLink, meetUrl: data.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri || null });
}
