# Ultimateweb

Ultimateweb is a local builder portal and backend for generating and iterating on landing pages. The project includes Supabase-backed authentication plus per-user persistence for build jobs and generated sites.

## Local Setup

1. Start Supabase from the project root:

```bash
supabase start
```

2. Copy the local Supabase values into `.env`:

```env
HOST=0.0.0.0
PORT=8787
FAL_KEY=...
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Print the local keys with:

```bash
supabase status -o env
```

3. Start the app server:

```bash
cd backend
node server.mjs
```

4. Open the builder portal at `http://127.0.0.1:8787`.

## Supabase Scope

- Auth uses Supabase email/password sign-up and sign-in.
- Sessions are stored in HTTP-only cookies.
- `build_jobs` stores job status, logs, and output metadata.
- `generated_sites` stores the per-user gallery and edit history.
- Generated site routes are protected so users can only access their own records.

## Database

The local Supabase project configuration lives in `supabase/config.toml`. The auth and persistence schema is defined in `supabase/migrations/20260317193000_auth_and_generated_sites.sql`.

## Notes

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` must be present or auth-protected flows return `503`.
- Local email confirmations are disabled in the checked-in Supabase config for faster development.
