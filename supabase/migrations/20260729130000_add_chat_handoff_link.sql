-- Optional external chat hand-off (Messenger, WhatsApp, Google Chat, etc.)
-- a member can set on their own profile. Shown only inside an active
-- in-app conversation (see project-hub.js), not on public profile views —
-- publishing a personal contact link to any anonymous visitor would be a
-- harassment/spam vector, but surfacing it once two people are already
-- messaging each other in-app is the same trust level as the messages
-- themselves.
alter table public.profiles
  add column if not exists chat_link text,
  add column if not exists chat_link_label text;

alter table public.profiles drop constraint if exists profiles_chat_link_length_check;
alter table public.profiles add constraint profiles_chat_link_length_check
  check (char_length(chat_link) <= 300);
alter table public.profiles drop constraint if exists profiles_chat_link_label_length_check;
alter table public.profiles add constraint profiles_chat_link_label_length_check
  check (char_length(chat_link_label) <= 40);

-- Re-issue the full column grant list (safe to rerun, matches the initial
-- schema's convention) — a plain ALTER TABLE ADD COLUMN does not retroactively
-- appear in an existing column-scoped GRANT.
revoke select on public.profiles from anon, authenticated;
grant select (
  id, display_name, headline, bio, skills, avatar_url, banner_url,
  custom_avatar, location_label, location_latitude, location_longitude,
  priority_match_active, chat_link, chat_link_label, created_at, updated_at
) on public.profiles to anon, authenticated;
revoke update on public.profiles from authenticated;
grant update (
  display_name, headline, bio, skills, avatar_url, banner_url,
  custom_avatar, location_label, location_latitude, location_longitude,
  chat_link, chat_link_label, updated_at
) on public.profiles to authenticated;
