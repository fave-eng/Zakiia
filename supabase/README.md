# Supabase files for Zakiya

This repository uses the shared English Space Supabase project:
`zqzgarvmpqqqaobeicpc`.

Included here:

- `config.toml` — links Supabase CLI to the shared project and keeps both Edge Functions on `verify_jwt = false`, matching their current deployment.
- `functions/notify-telegram/index.ts` — shared Telegram notification function used for new-material notifications and homework reports.
- `functions/diagnostics-zakiya/index.ts` — Zakiya-only diagnostics function.
- `telegram-notifications-direct.sql` — idempotent registration of Zakiya's Telegram destination: chat `-1004358925459`, topic `5`.

Zakiya's website uses `student_id = zakiya` in the shared progress tables. Do not replace the project ID with the old standalone Zakiya Supabase project; that old project is retained only as a legacy migration source in the website configuration.
