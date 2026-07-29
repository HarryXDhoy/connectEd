-- The globe's connection arcs were scoped to only the signed-in viewer's
-- own applications, via applications' own RLS (view your own rows, or
-- rows for projects you own). That's the right restriction for the
-- Applications table itself (message/answers are private), but it meant
-- the "member network" arcs were only ever visible to someone who
-- personally had an accepted/pending application — everyone else saw an
-- empty globe regardless of how much real activity existed platform-wide.
--
-- This function exposes only the minimum needed to draw a connection line
-- (who's paired with whom, and whether it's confirmed or still pending
-- interview) for CONFIRMED relationships only (accepted/interview) — never
-- pending applications (that's a private "did I apply" signal) and never
-- the application message/answers.
create or replace function public.public_team_connections()
returns table (owner_id uuid, applicant_id uuid, status text)
language sql
stable
security definer
set search_path = public
as $$
  select projects.owner_id, applications.applicant_id, applications.status
  from public.applications
  join public.projects on projects.id = applications.project_id
  where applications.status in ('accepted', 'interview')
    and projects.owner_id <> applications.applicant_id;
$$;

revoke all on function public.public_team_connections() from public;
grant execute on function public.public_team_connections() to anon, authenticated;
