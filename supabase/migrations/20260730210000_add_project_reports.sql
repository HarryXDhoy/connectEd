create table if not exists public.project_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  details text not null default '',
  status text not null default 'open',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (project_id, reporter_id),
  check (
    reason in (
      'spam_or_scam',
      'harassment_or_hate',
      'sexual_content',
      'violence',
      'copyright',
      'other'
    )
  ),
  check (char_length(details) <= 2000),
  check (reason <> 'other' or char_length(btrim(details)) >= 10),
  check (status in ('open', 'reviewing', 'resolved', 'dismissed'))
);

create index if not exists project_reports_moderation_queue_idx
  on public.project_reports (status, created_at desc);

alter table public.project_reports enable row level security;

drop policy if exists "members report projects" on public.project_reports;
drop policy if exists "members read own reports" on public.project_reports;

create policy "members report projects"
  on public.project_reports
  for insert
  to authenticated
  with check (
    auth.uid() = reporter_id
    and exists (
      select 1
      from public.projects
      where projects.id = project_reports.project_id
        and projects.owner_id <> auth.uid()
    )
  );

create policy "members read own reports"
  on public.project_reports
  for select
  to authenticated
  using (auth.uid() = reporter_id);

revoke all on public.project_reports from anon;
grant select, insert on public.project_reports to authenticated;

comment on table public.project_reports is
  'Confidential member reports. Service-role moderation tooling can review the full queue.';
