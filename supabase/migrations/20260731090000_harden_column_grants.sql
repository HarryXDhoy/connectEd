-- Close the column-privilege gaps that let a client write columns the schema
-- never meant it to write.
--
-- The security model here is two-layer: RLS decides which ROWS a user can
-- touch, column-level GRANTs decide which COLUMNS can ever be written. The
-- UPDATE grants were narrowed carefully throughout the initial schema; the
-- INSERT grants were left table-wide, which silently reopened every hole the
-- UPDATE narrowing closed — a policy that never mentions a column cannot
-- constrain it, so INSERT was the unguarded door into `applications.status`,
-- `projects.boost_until`, and `interviews.meet_url`.
--
-- Safe to rerun: every grant is preceded by its revoke, every policy by a
-- drop-if-exists, and every constraint by a drop-if-exists.

-- ---------------------------------------------------------------------------
-- applications: an applicant could accept their own application
-- ---------------------------------------------------------------------------
-- UPDATE was already restricted to (status, updated_at) behind an owner-only
-- policy, so an applicant could never PATCH themselves to 'accepted'. But
-- INSERT was table-wide and the "applicants create applications" WITH CHECK
-- constrains applicant_id and the project's openness while saying nothing
-- about status — so the applicant simply chose their own starting status.
--
-- That is not a cosmetic badge. status = 'accepted' satisfies
-- is_project_participant(), which is the sole gate on the "project
-- participants read accepted teammates" SELECT policy — so a forged row let
-- the attacker read the private `message` and `answers` of every accepted or
-- interviewing applicant on that project, and post permanently public
-- project_reviews about the owner and real teammates.
--
-- Dropping status from the grant makes it fall back to its `default 'pending'`.
revoke insert on public.applications from authenticated;
grant insert (project_id, applicant_id, message, answers)
  on public.applications to authenticated;

-- Belt and braces: state the invariant in the policy too, so a future
-- re-broadening of the grant cannot silently reopen this.
drop policy if exists "applicants create applications" on public.applications;
create policy "applicants create applications"
  on public.applications for insert
  with check (
    auth.uid() = applicant_id
    and status = 'pending'
    and exists (
      select 1 from public.projects
      where projects.id = applications.project_id
        and projects.status = 'open'
        and not ('__applications_paused__' = any(projects.tags))
        and projects.owner_id <> auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- projects: any user could grant themselves free permanent paid placement
-- ---------------------------------------------------------------------------
-- boost_until is deliberately absent from the UPDATE grant so a boost can only
-- come from activate_plus_boost(), which checks for a live entitlement. INSERT
-- was table-wide, and "users create own projects" only pins owner_id — so a
-- free account could create a project with boost_until far in the future and
-- outrank every paying Plus subscriber indefinitely. activate_plus_boost only
-- clears competing boosts belonging to the same owner, so a real subscriber
-- could never displace it.
revoke insert on public.projects from authenticated;
grant insert (owner_id, title, summary, description, tags, status, seats_total)
  on public.projects to authenticated;

-- Same table-wide-grant pattern on project_questions. Lower stakes (there is
-- no privileged column here today) but it keeps the convention consistent, so
-- a future column added to this table is locked down by default rather than
-- writable by default.
revoke insert, update on public.project_questions from authenticated;
grant insert (project_id, prompt, required, position)
  on public.project_questions to authenticated;
grant update (prompt, required, position)
  on public.project_questions to authenticated;

-- ---------------------------------------------------------------------------
-- interviews: table-wide UPDATE reopened the hole 20260730200000 closed
-- ---------------------------------------------------------------------------
-- The hardened INSERT policy verifies that the project, the application and
-- the candidate actually belong together. "organizers update interviews" pins
-- only organizer_id, and the grant covered every column — so an organizer
-- could create one legitimate interview and then UPDATE candidate_id to any
-- user id on the platform (the victim then sees a fabricated interview via
-- "interview participants read"), retarget project_id, or point meet_url at
-- an arbitrary URL rendered to the candidate behind an "Open Meet" button.
--
-- Column scoping is the whole fix: project_id, application_id, organizer_id
-- and candidate_id are simply not updatable any more, so the relationship the
-- INSERT policy established cannot be broken afterwards. Re-stating that
-- relationship in the UPDATE policy's WITH CHECK was considered and rejected —
-- application_id is nullable (`on delete set null`), so an existence check
-- there would lock the organizer out of editing the time or title of a
-- perfectly valid interview whose application row had since been deleted.
revoke insert, update on public.interviews from authenticated;
grant insert (
  project_id, application_id, organizer_id, candidate_id,
  starts_at, ends_at, title, notes
) on public.interviews to authenticated;
grant update (starts_at, ends_at, title, notes) on public.interviews to authenticated;

-- google_event_id, meet_url and calendar_html_link are now written only by
-- api/google-calendar.js with the service role — the same treatment
-- projects.boost_until already gets. They are Google's values, not the
-- organizer's, and nothing good comes of letting a client choose them.

-- ---------------------------------------------------------------------------
-- profiles.chat_link: world-readable, which its own migration forbids
-- ---------------------------------------------------------------------------
-- 20260729130000 added chat_link/chat_link_label to the blanket SELECT grant
-- on a table whose RLS is `using (true)`. Its own comment says the link must
-- appear "only inside an active in-app conversation … publishing a personal
-- contact link to any anonymous visitor would be a harassment/spam vector."
-- The UI honoured that; the API did not — anyone could GET
-- /rest/v1/profiles?select=chat_link unauthenticated and harvest every
-- member's personal WhatsApp/Messenger link in one request.
--
-- Re-issue the grant list without them (a column-scoped GRANT is a whole
-- replacement, not an increment, so the full list has to be restated).
revoke select on public.profiles from anon, authenticated;
grant select (
  id, display_name, headline, bio, skills, avatar_url, banner_url,
  custom_avatar, location_label, location_latitude, location_longitude,
  priority_match_active, created_at, updated_at
) on public.profiles to anon, authenticated;

-- The update grant is unchanged in substance — a member may still edit their
-- own chat link, since RLS already confines that to their own row. Restated
-- here only because it sits next to the select grant it must stay in step with.
revoke update on public.profiles from authenticated;
grant update (
  display_name, headline, bio, skills, avatar_url, banner_url,
  custom_avatar, location_label, location_latitude, location_longitude,
  chat_link, chat_link_label, updated_at
) on public.profiles to authenticated;

-- Encode "only once you are already talking in-app" in Postgres rather than in
-- project-hub.js. Also returns your own link, so the profile form can still be
-- populated with what you previously saved.
-- Output columns are named link/label rather than chat_link/chat_link_label:
-- a `returns table` column name is in scope inside the body, so reusing the
-- source column's name there invites an ambiguous-reference error.
create or replace function public.chat_link_for(target_user uuid)
returns table (link text, label text)
language sql
stable
security definer
set search_path = public
as $$
  select profiles.chat_link, profiles.chat_link_label
  from public.profiles
  where profiles.id = target_user
    and auth.uid() is not null
    and (
      target_user = auth.uid()
      or exists (
        select 1
        from public.messages
        where (messages.sender_id = auth.uid() and messages.recipient_id = target_user)
           or (messages.sender_id = target_user and messages.recipient_id = auth.uid())
      )
    );
$$;

revoke all on function public.chat_link_for(uuid) from public, anon;
grant execute on function public.chat_link_for(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- profiles: bound the client-writable free-text columns
-- ---------------------------------------------------------------------------
-- Every other user-writable field in this schema carries a char_length check.
-- These four never did, so the only limit was the `maxlength` attribute in the
-- HTML — which is a usability affordance, not an access control, and is absent
-- entirely for anyone posting straight at the REST API.
--
-- NOT VALID on purpose: it enforces the bound on every future insert and
-- update while leaving any pre-existing oversized row in place, so applying
-- this migration cannot fail on legacy data. Cleaning up rows already over the
-- limit is a service-role task, not something to automate destructively here.
-- Limits are set well above the form's own maxlength values so no legitimate
-- profile can collide with them.
alter table public.profiles drop constraint if exists profiles_display_name_length_check;
alter table public.profiles add constraint profiles_display_name_length_check
  check (char_length(display_name) <= 120) not valid;

alter table public.profiles drop constraint if exists profiles_headline_length_check;
alter table public.profiles add constraint profiles_headline_length_check
  check (char_length(headline) <= 200) not valid;

alter table public.profiles drop constraint if exists profiles_bio_length_check;
alter table public.profiles add constraint profiles_bio_length_check
  check (char_length(bio) <= 4000) not valid;

alter table public.profiles drop constraint if exists profiles_skills_size_check;
alter table public.profiles add constraint profiles_skills_size_check
  check (
    coalesce(array_length(skills, 1), 0) <= 40
    and coalesce(char_length(array_to_string(skills, ',')), 0) <= 2000
  ) not valid;

-- ---------------------------------------------------------------------------
-- Let a withdrawn application be sent again
-- ---------------------------------------------------------------------------
-- withdraw_application() sets status = 'withdrawn' and leaves the row in
-- place, and applications carries unique(project_id, applicant_id) — so
-- withdrawing permanently barred the applicant from that project. A fresh
-- INSERT hit 23505 ("You already applied to this project") and the hub's
-- own apply gate treated the withdrawn row as an existing application, so the
-- form never reappeared. Nothing in the confirm dialog warned that cancelling
-- was irreversible.
--
-- Mirrors withdraw_application in shape. The project conditions repeat the
-- INSERT policy's, so re-applying can never bypass a pause, a closed project,
-- or the no-applying-to-your-own-project rule that a fresh insert would face.
create or replace function public.reapply_application(target_application uuid)
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
  set status = 'pending'
  where id = target_application
    and applicant_id = auth.uid()
    and status = 'withdrawn'
    and exists (
      select 1 from public.projects
      where projects.id = applications.project_id
        and projects.status = 'open'
        and not ('__applications_paused__' = any(projects.tags))
        and projects.owner_id <> auth.uid()
    );

  if not found then
    raise exception 'This application cannot be sent again — the project may no longer be accepting applications.';
  end if;
end;
$$;

revoke all on function public.reapply_application(uuid) from public, anon;
grant execute on function public.reapply_application(uuid) to authenticated;
