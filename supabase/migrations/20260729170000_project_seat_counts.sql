-- Every "N seats" display across the app showed seats_total verbatim —
-- a static number set once at project creation, never reduced as people
-- were actually accepted. A project with 5 seats and 5 already-accepted
-- teammates still advertised "5 seats" to a new visitor as if none were
-- taken.
--
-- Mirrors the public_team_connections() pattern: exposes only the
-- minimum aggregate needed (how many accepted applications a project
-- has), never application content, callable by anyone since seat
-- availability is meant to be public the same way the project listing
-- itself is.
create or replace function public.project_seat_counts()
returns table (project_id uuid, accepted_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select project_id, count(*)::bigint as accepted_count
  from public.applications
  where status = 'accepted'
  group by project_id;
$$;

revoke all on function public.project_seat_counts() from public;
grant execute on function public.project_seat_counts() to anon, authenticated;
