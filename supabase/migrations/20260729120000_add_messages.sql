-- Direct messages between two members. Mirrors the RLS + column-level
-- grant pattern used throughout the initial schema: RLS restricts rows,
-- explicit column grants restrict which columns can ever be written.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (sender_id <> recipient_id),
  check (char_length(body) between 1 and 4000)
);

-- Conversation lookups filter on "the other participant" without caring
-- which side sent which message, so index both orderings via the pair.
create index if not exists messages_conversation_idx
  on public.messages (least(sender_id, recipient_id), greatest(sender_id, recipient_id), created_at);
create index if not exists messages_recipient_unread_idx
  on public.messages (recipient_id, read_at);

alter table public.messages enable row level security;

drop policy if exists "participants read messages" on public.messages;
drop policy if exists "senders create messages" on public.messages;
drop policy if exists "recipients mark messages read" on public.messages;

create policy "participants read messages"
  on public.messages for select
  using (auth.uid() in (sender_id, recipient_id));

create policy "senders create messages"
  on public.messages for insert
  with check (auth.uid() = sender_id);

-- Only the "read_at" column is grantable for update (below), so this
-- policy only ever gates that flip — a sender can't use UPDATE to alter
-- their own message body or reassign the recipient.
create policy "recipients mark messages read"
  on public.messages for update
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

grant select, insert on public.messages to authenticated;
revoke update, delete on public.messages from authenticated;
grant update (read_at) on public.messages to authenticated;

-- Safe to rerun: only add to the realtime publication if it isn't already
-- a member (ALTER PUBLICATION ... ADD TABLE errors on a duplicate add).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
