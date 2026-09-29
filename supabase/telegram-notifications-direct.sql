-- Zakiya: Telegram destination for the shared English Space Supabase project.
-- Current shared project: zqzgarvmpqqqaobeicpc
-- This file is safe to keep in the repository as the source-of-truth for Zakiya's Telegram destination.
-- Run it only if you need to restore/register Zakiya in Supabase.

-- The shared project already contains public.telegram_recipients.
-- Ensure topic support exists, then register Zakiya in topic /5.
alter table public.telegram_recipients
  add column if not exists message_thread_id bigint;

insert into public.telegram_recipients (
  student_id,
  chat_id,
  message_thread_id,
  enabled
)
values (
  'zakiya',
  -1004358925459,
  5,
  true
)
on conflict (student_id) do update
set chat_id = excluded.chat_id,
    message_thread_id = excluded.message_thread_id,
    enabled = true,
    updated_at = now();
