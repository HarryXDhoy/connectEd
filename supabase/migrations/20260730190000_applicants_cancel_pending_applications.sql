alter table public.applications
  drop constraint if exists applications_status_check;

alter table public.applications
  add constraint applications_status_check
  check (status in ('pending', 'accepted', 'declined', 'interview', 'withdrawn'));

drop policy if exists "owners review applications" on public.applications;

create policy "owners review applications"
  on public.applications for update
  using (
    status <> 'withdrawn'
    and auth.uid() = (
      select owner_id from public.projects where id = applications.project_id
    )
  )
  with check (
    status <> 'withdrawn'
    and auth.uid() = (
      select owner_id from public.projects where id = applications.project_id
    )
  );

create or replace function public.withdraw_application(target_application uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  update public.applications
  set status = 'withdrawn'
  where id = target_application
    and applicant_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Only your pending applications can be withdrawn.';
  end if;
end;
$$;

revoke all on function public.withdraw_application(uuid) from public, anon;
grant execute on function public.withdraw_application(uuid) to authenticated;
