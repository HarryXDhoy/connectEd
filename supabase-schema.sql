-- connectEd production schema for Supabase.
-- Safe to rerun: policies, triggers, and grants are replaced in place.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  headline text not null default '',
  bio text not null default '',
  skills text[] not null default '{}',
  avatar_url text,
  priority_match_active boolean not null default false,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  summary text not null,
  description text not null,
  tags text[] not null default '{}',
  status text not null default 'open',
  seats_total integer not null default 3,
  boost_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_questions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  prompt text not null,
  required boolean not null default true,
  position integer not null default 0
);

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  applicant_id uuid not null references public.profiles(id) on delete cascade,
  message text not null,
  answers jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, applicant_id)
);

create table if not exists public.interviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  application_id uuid references public.applications(id) on delete set null,
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  candidate_id uuid not null references public.profiles(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  title text not null,
  notes text not null default '',
  google_event_id text,
  meet_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.project_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id) on delete cascade,
  reviewee_id uuid not null references public.profiles(id) on delete cascade,
  rating smallint not null,
  comment text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, reviewer_id, reviewee_id),
  check (reviewer_id <> reviewee_id),
  check (rating between 1 and 5),
  check (char_length(comment) <= 1200)
);

create table if not exists public.billing_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan text not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  project_id uuid references public.projects(id) on delete cascade,
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists priority_match_active boolean not null default false;
alter table public.profiles
  add column if not exists stripe_customer_id text;
alter table public.profiles
  add column if not exists stripe_subscription_id text;
alter table public.projects
  add column if not exists boost_until timestamptz;

alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check
  check (status in ('open', 'invite_only', 'closed'));
alter table public.projects drop constraint if exists projects_seats_total_check;
alter table public.projects add constraint projects_seats_total_check
  check (seats_total between 1 and 50);
alter table public.projects drop constraint if exists projects_title_length_check;
alter table public.projects add constraint projects_title_length_check
  check (char_length(title) between 4 and 120);
alter table public.projects drop constraint if exists projects_summary_length_check;
alter table public.projects add constraint projects_summary_length_check
  check (char_length(summary) between 12 and 240);
alter table public.projects drop constraint if exists projects_description_length_check;
alter table public.projects add constraint projects_description_length_check
  check (char_length(description) between 40 and 8000);

alter table public.project_questions drop constraint if exists project_questions_prompt_length_check;
alter table public.project_questions add constraint project_questions_prompt_length_check
  check (char_length(prompt) between 8 and 500);

alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications add constraint applications_status_check
  check (status in ('pending', 'accepted', 'declined', 'interview'));
alter table public.applications drop constraint if exists applications_message_length_check;
alter table public.applications add constraint applications_message_length_check
  check (char_length(message) between 20 and 3000);

alter table public.interviews drop constraint if exists interviews_time_check;
alter table public.interviews add constraint interviews_time_check
  check (
    ends_at > starts_at
    and ends_at - starts_at between interval '15 minutes' and interval '3 hours'
  );

alter table public.billing_entitlements drop constraint if exists billing_entitlements_plan_check;
alter table public.billing_entitlements add constraint billing_entitlements_plan_check
  check (plan in ('priority_match', 'project_boost', 'team'));

create index if not exists projects_owner_idx
  on public.projects(owner_id, created_at desc);
create index if not exists projects_discovery_idx
  on public.projects(status, boost_until desc, created_at desc);
create index if not exists project_questions_project_idx
  on public.project_questions(project_id, position);
create index if not exists applications_project_idx
  on public.applications(project_id, status, created_at desc);
create index if not exists applications_applicant_idx
  on public.applications(applicant_id, created_at desc);
create index if not exists interviews_participants_idx
  on public.interviews(organizer_id, candidate_id, starts_at);
create index if not exists project_reviews_reviewee_idx
  on public.project_reviews(reviewee_id, created_at desc);
create index if not exists project_reviews_project_idx
  on public.project_reviews(project_id, created_at desc);
create index if not exists billing_entitlements_user_idx
  on public.billing_entitlements(user_id, plan, active);

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_questions enable row level security;
alter table public.applications enable row level security;
alter table public.interviews enable row level security;
alter table public.project_reviews enable row level security;
alter table public.billing_entitlements enable row level security;

drop policy if exists "profiles are readable" on public.profiles;
drop policy if exists "users edit own profile" on public.profiles;
drop policy if exists "users update own profile" on public.profiles;
drop policy if exists "projects are readable" on public.projects;
drop policy if exists "users create own projects" on public.projects;
drop policy if exists "owners edit own projects" on public.projects;
drop policy if exists "owners delete own projects" on public.projects;
drop policy if exists "questions are readable" on public.project_questions;
drop policy if exists "owners manage questions" on public.project_questions;
drop policy if exists "applicants create applications" on public.applications;
drop policy if exists "applicants read own applications" on public.applications;
drop policy if exists "owners read project applications" on public.applications;
drop policy if exists "owners review applications" on public.applications;
drop policy if exists "project participants read accepted teammates" on public.applications;
drop policy if exists "interview participants read" on public.interviews;
drop policy if exists "organizers create interviews" on public.interviews;
drop policy if exists "organizers update interviews" on public.interviews;
drop policy if exists "organizers delete interviews" on public.interviews;
drop policy if exists "reviews are readable" on public.project_reviews;
drop policy if exists "participants create reviews" on public.project_reviews;
drop policy if exists "reviewers update own reviews" on public.project_reviews;
drop policy if exists "users read own entitlements" on public.billing_entitlements;

create or replace function public.is_project_participant(target_project uuid, target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from public.projects
      where projects.id = target_project
        and projects.owner_id = target_user
    )
    or exists (
      select 1
      from public.applications
      where applications.project_id = target_project
        and applications.applicant_id = target_user
        and applications.status in ('accepted', 'interview')
    );
$$;

revoke all on function public.is_project_participant(uuid, uuid) from public;
grant execute on function public.is_project_participant(uuid, uuid) to authenticated;

create policy "profiles are readable"
  on public.profiles for select
  using (true);

create policy "users update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "projects are readable"
  on public.projects for select
  using (status <> 'closed' or auth.uid() = owner_id);

create policy "users create own projects"
  on public.projects for insert
  with check (auth.uid() = owner_id);

create policy "owners edit own projects"
  on public.projects for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owners delete own projects"
  on public.projects for delete
  using (auth.uid() = owner_id);

create policy "questions are readable"
  on public.project_questions for select
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_questions.project_id
        and (projects.status <> 'closed' or projects.owner_id = auth.uid())
    )
  );

create policy "owners manage questions"
  on public.project_questions for all
  using (
    auth.uid() = (
      select owner_id from public.projects where id = project_questions.project_id
    )
  )
  with check (
    auth.uid() = (
      select owner_id from public.projects where id = project_questions.project_id
    )
  );

create policy "applicants create applications"
  on public.applications for insert
  with check (
    auth.uid() = applicant_id
    and exists (
      select 1 from public.projects
      where projects.id = applications.project_id
        and projects.status = 'open'
        and not ('__applications_paused__' = any(projects.tags))
        and projects.owner_id <> auth.uid()
    )
  );

create policy "applicants read own applications"
  on public.applications for select
  using (auth.uid() = applicant_id);

create policy "owners read project applications"
  on public.applications for select
  using (
    auth.uid() = (
      select owner_id from public.projects where id = applications.project_id
    )
  );

create policy "owners review applications"
  on public.applications for update
  using (
    auth.uid() = (
      select owner_id from public.projects where id = applications.project_id
    )
  )
  with check (
    auth.uid() = (
      select owner_id from public.projects where id = applications.project_id
    )
  );

create policy "project participants read accepted teammates"
  on public.applications for select
  using (
    status in ('accepted', 'interview')
    and public.is_project_participant(project_id, auth.uid())
  );

create policy "interview participants read"
  on public.interviews for select
  using (auth.uid() in (organizer_id, candidate_id));

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
    )
  );

create policy "organizers update interviews"
  on public.interviews for update
  using (auth.uid() = organizer_id)
  with check (auth.uid() = organizer_id);

create policy "organizers delete interviews"
  on public.interviews for delete
  using (auth.uid() = organizer_id);

create policy "reviews are readable"
  on public.project_reviews for select
  using (true);

create policy "participants create reviews"
  on public.project_reviews for insert
  with check (
    auth.uid() = reviewer_id
    and public.is_project_participant(project_id, reviewer_id)
    and public.is_project_participant(project_id, reviewee_id)
  );

create policy "reviewers update own reviews"
  on public.project_reviews for update
  using (auth.uid() = reviewer_id)
  with check (
    auth.uid() = reviewer_id
    and public.is_project_participant(project_id, reviewer_id)
    and public.is_project_participant(project_id, reviewee_id)
  );

create policy "users read own entitlements"
  on public.billing_entitlements for select
  using (auth.uid() = user_id);

-- Hide billing identifiers from the public profile API and prevent users
-- from granting themselves paid placement.
revoke select on public.profiles from anon, authenticated;
grant select (
  id, display_name, headline, bio, skills, avatar_url,
  priority_match_active, created_at, updated_at
) on public.profiles to anon, authenticated;
revoke update on public.profiles from authenticated;
grant update (
  display_name, headline, bio, skills, avatar_url, updated_at
) on public.profiles to authenticated;

grant select on public.projects, public.project_questions to anon, authenticated;
grant insert, delete on public.projects, public.project_questions to authenticated;
revoke update on public.projects from authenticated;
grant update (
  title, summary, description, tags, status, seats_total, updated_at
) on public.projects to authenticated;
grant update on public.project_questions to authenticated;
grant select, insert on public.applications to authenticated;
revoke update on public.applications from authenticated;
grant update (status, updated_at) on public.applications to authenticated;
grant select, insert, update, delete on public.interviews to authenticated;
grant select on public.project_reviews to anon, authenticated;
grant insert on public.project_reviews to authenticated;
grant update (rating, comment, updated_at) on public.project_reviews to authenticated;

revoke select on public.billing_entitlements from authenticated;
grant select (
  id, user_id, plan, project_id, active, starts_at, ends_at, created_at
) on public.billing_entitlements to authenticated;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row execute procedure public.set_updated_at();

drop trigger if exists applications_set_updated_at on public.applications;
create trigger applications_set_updated_at
before update on public.applications
for each row execute procedure public.set_updated_at();

drop trigger if exists project_reviews_set_updated_at on public.project_reviews;
create trigger project_reviews_set_updated_at
before update on public.project_reviews
for each row execute procedure public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    left(
      coalesce(
        nullif(new.raw_user_meta_data->>'full_name', ''),
        split_part(new.email, '@', 1),
        'connectEd member'
      ),
      80
    ),
    coalesce(
      nullif(new.raw_user_meta_data->>'avatar_url', ''),
      nullif(new.raw_user_meta_data->>'picture', '')
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.activate_plus_boost(target_project uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  entitlement_end timestamptz;
  activated_until timestamptz;
begin
  select coalesce(ends_at, now() + interval '31 days')
    into entitlement_end
  from public.billing_entitlements
  where user_id = auth.uid()
    and plan = 'priority_match'
    and active = true
    and (ends_at is null or ends_at > now())
  order by created_at desc
  limit 1;

  if entitlement_end is null then
    raise exception 'An active connectEd Plus subscription is required.';
  end if;

  if not exists (
    select 1 from public.projects
    where id = target_project
      and owner_id = auth.uid()
      and status <> 'closed'
  ) then
    raise exception 'Choose one of your active projects.';
  end if;

  update public.projects
  set boost_until = null
  where owner_id = auth.uid()
    and id <> target_project
    and boost_until > now();

  activated_until := least(entitlement_end, now() + interval '31 days');
  update public.projects
  set boost_until = activated_until
  where id = target_project and owner_id = auth.uid();

  return activated_until;
end;
$$;

revoke all on function public.activate_plus_boost(uuid) from public, anon;
grant execute on function public.activate_plus_boost(uuid) to authenticated;
