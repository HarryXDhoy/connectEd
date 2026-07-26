-- connectEd production schema for Supabase.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  headline text not null default '',
  bio text not null default '',
  skills text[] not null default '{}',
  avatar_url text,
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
  status text not null default 'open' check (status in ('open','invite_only','closed')),
  seats_total integer not null default 3 check (seats_total > 0),
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
  status text not null default 'pending' check (status in ('pending','accepted','declined','interview')),
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

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_questions enable row level security;
alter table public.applications enable row level security;
alter table public.interviews enable row level security;

alter table public.profiles add column if not exists priority_match_active boolean not null default false;
alter table public.profiles add column if not exists stripe_customer_id text;
alter table public.profiles add column if not exists stripe_subscription_id text;
alter table public.projects add column if not exists boost_until timestamptz;

create table if not exists public.billing_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan text not null check (plan in ('priority_match','project_boost','team')),
  stripe_customer_id text,
  stripe_subscription_id text,
  project_id uuid references public.projects(id) on delete cascade,
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists billing_entitlements_user_idx on public.billing_entitlements(user_id, plan, active);
alter table public.billing_entitlements enable row level security;
create policy "users read own entitlements" on public.billing_entitlements for select using (auth.uid() = user_id);

create policy "profiles are readable" on public.profiles for select using (true);
create policy "users edit own profile" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "projects are readable" on public.projects for select using (status <> 'closed' or auth.uid() = owner_id);
create policy "users create own projects" on public.projects for insert with check (auth.uid() = owner_id);
create policy "owners edit own projects" on public.projects for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owners delete own projects" on public.projects for delete using (auth.uid() = owner_id);
create policy "questions are readable" on public.project_questions for select using (true);
create policy "owners manage questions" on public.project_questions for all using (auth.uid() = (select owner_id from public.projects where id = project_id)) with check (auth.uid() = (select owner_id from public.projects where id = project_id));
create policy "applicants create applications" on public.applications for insert with check (auth.uid() = applicant_id);
create policy "applicants read own applications" on public.applications for select using (auth.uid() = applicant_id);
create policy "owners read project applications" on public.applications for select using (auth.uid() = (select owner_id from public.projects where id = project_id));
create policy "owners review applications" on public.applications for update using (auth.uid() = (select owner_id from public.projects where id = project_id));
create policy "interview participants read" on public.interviews for select using (auth.uid() in (organizer_id, candidate_id));
create policy "organizers create interviews" on public.interviews for insert with check (auth.uid() = organizer_id);

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();
