-- Add 'declined' to the globe's connection status set. Still never
-- exposes the application message/answers, and still only exposes the
-- minimum needed to draw a line (who, and what happened between them).
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
  where applications.status in ('accepted', 'interview', 'declined')
    and projects.owner_id <> applications.applicant_id;
$$;

revoke all on function public.public_team_connections() from public;
grant execute on function public.public_team_connections() to anon, authenticated;
