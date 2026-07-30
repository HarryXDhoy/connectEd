drop policy if exists "organizers create interviews" on public.interviews;

create policy "organizers create interviews"
  on public.interviews for insert
  with check (
    auth.uid() = organizer_id
    and exists (
      select 1
      from public.projects
      join public.applications
        on applications.project_id = projects.id
      where projects.id = interviews.project_id
        and projects.owner_id = auth.uid()
        and applications.id = interviews.application_id
        and applications.applicant_id = interviews.candidate_id
        and applications.status in ('pending', 'accepted', 'interview')
    )
  );
