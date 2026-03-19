# Ultimateweb

Ultimateweb is a local website-generation system for building, storing, and iterating on animated landing pages. It serves a browser-based builder portal, runs a FAL-powered media/site pipeline, stores per-user history in Supabase, and includes an in-browser editor for revising generated sites.

## Key Features

- Supabase-backed authentication with email/password and Google OAuth
- Private per-user gallery and build history
- FAL-powered site generation pipeline
- Support for uploaded or reused start images, end images, and video
- SEO-ready generated output with canonical/OG/Twitter/JSON-LD support
- Three site modes: `conversion`, `editorial`, and `hybrid`
- Edit flow for rebuilding an existing generated site
- In-browser editor with structured content overrides
- In-browser editor support for cinematic motion layers on the hero and individual sections
- Protected generated-site serving with a small public sample allowlist

## Current Product Scope

- Authentication is required for builds, gallery access, editing, deletion, and non-public generated-site URLs.
- Auth supports email/password sign-up, email/password sign-in, and Google OAuth through Supabase.
- Sessions are stored in HTTP-only cookies and are refreshed server-side when possible.
- Builds are created by spawning `skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs`.
- Build requests support:
  - `topic`
  - `pageMode`: `conversion`, `editorial`, or `hybrid`
  - `existingWebsite`
  - comma-separated color overrides
  - uploaded or reused start image, end image, and video
  - prompt overrides for start image, end image, and video
  - `changeRequest`
  - edit-mode rebuilds from an existing generated site
  - structured `contentOverrides` from the editor
  - optional `siteUrl` for production SEO/canonical output
  - optional cinematic layers with per-slot video, layout, loop mode, and playback speed
- Completed sites are persisted per user in Supabase and served from `generated-sites/<slug>/`.
- A small allowlist of sample slugs is public; everything else under `/generated-sites/*` is account-scoped.

## Project Layout

- `shared/builder-server.mjs`: main HTTP server, auth flows, build orchestration, gallery APIs, generated-site access control, and static file serving.
- `shared/supabase.mjs`: Supabase auth/session helpers plus `build_jobs` and `generated_sites` persistence.
- `backend/server.mjs`: starts the shared server against `frontend/`.
- `builder-portal/server.mjs`: starts the same shared server against `builder-portal/public/`.
- `frontend/`: main builder UI, editor UI, styles, favicon, and config endpoint assets.
- `generated-sites/`: built output plus local sample/public artifacts.
- `skills/fal-futuristic-website-builder/`: generation pipeline invoked by the server.
- `supabase/`: local config, seeds, and migrations.

## Main Routes

- `GET /`: builder portal
- `GET /editor.html?slug=<slug>`: inline editor for a generated site
- `GET /api/config`: injects `ULTIMATEWEB_API_BASE` and whether Supabase is configured
- `GET /api/auth/session`
- `GET /api/auth/google`
- `POST /api/auth/sign-in`
- `POST /api/auth/sign-up`
- `POST /api/auth/oauth/session`
- `POST /api/auth/sign-out`
- `POST /api/build`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/gallery`
- `GET /api/sites/:slug`
- `DELETE /api/sites/:slug`
- `POST /api/sites/:slug/delete`
- `GET /generated-sites/*`

## Local Setup

1. Start local Supabase from the project root:

```bash
supabase start
```

2. Copy the local values into `.env`. The checked-in template is `.env.example`.

```env
HOST=127.0.0.1
PORT=8787
FAL_KEY=

SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Only needed if the frontend is on a different origin.
ULTIMATEWEB_ALLOWED_ORIGINS=http://127.0.0.1:8787
```

Get the local Supabase values with:

```bash
supabase status -o env
```

3. Start either server entrypoint:

```bash
cd backend
node server.mjs
```

or

```bash
cd builder-portal
node server.mjs
```

4. Open `http://127.0.0.1:8787`.

## How It Fits Together

- The frontend calls `/api/config` first to discover backend base URL and whether Supabase is enabled.
- The shared server handles auth, session cookies, build requests, job polling, gallery reads, deletion, and generated-site access checks.
- Build jobs spawn the FAL pipeline script and then persist both job state and completed site metadata to Supabase.
- The editor loads an existing generated site, lets the user modify content/media inputs, manage cinematic hero/section motion layers, and sends a rebuild request using `contentOverrides` plus optional replacement media.

## Environment Notes

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are all required for auth-backed flows. If any are missing, auth endpoints and private routes return `503` or unauthenticated behavior.
- `FAL_KEY` is required for builds that need the pipeline to generate video. If a request already provides a video file or video URL, the server can still run without `FAL_KEY`.
- `ULTIMATEWEB_ALLOWED_ORIGINS` controls credentialed CORS when the frontend is hosted on a different origin.
- `ULTIMATEWEB_API_BASE` is emitted by `/api/config` so the frontend/editor can target a different backend base URL.

## SEO And Premium Motion

- The generator now emits SEO-oriented metadata by default, including title, description, Open Graph, Twitter card tags, JSON-LD, and a self-contained favicon.
- When a real public URL is known, `siteUrl` enables canonical URL output plus production `robots.txt` and `sitemap.xml`.
- The editor now supports `Cinematic Layers`, an optional premium motion treatment for the hero and each section.
- Each cinematic slot can be configured as a `card` or `full background`, with `loop` or `boomerang` playback and adjustable speed.
- Cinematic layers are regenerated on publish and stored in the generated site metadata for future edits.

## Data Model

- `build_jobs`: queue/running/completed/failed state, logs, error text, thumbnail URL, site URL, metadata URL, and timestamps.
- `generated_sites`: per-user site catalog with slug, topic, title, page mode, palette, prompts, edit lineage, soft deletion, and timestamps.
- Row-level security is enabled for both tables, and records are scoped to `auth.uid()`.

Schema source:

- `supabase/config.toml`
- `supabase/migrations/20260317193000_auth_and_generated_sites.sql`

## Operational Notes

- The server auto-loads environment variables from the repo root `.env`.
- Backend logging is appended to `/tmp/ultimateweb-backend.log`.
- The repo currently has untracked generated output under `generated-sites/`; treat that directory as runtime/project data rather than core app source.
- Public sample cards on the homepage point at checked-in sample slugs under `frontend/samples/` and selected public slugs under `generated-sites/`.
- A full-screen unsaved editor preview route is the next planned enhancement; current cinematic layers preview live inside the editor iframe and publish into the generated site output.
