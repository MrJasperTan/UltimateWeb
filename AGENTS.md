# Ultimateweb Agent Notes

This file is the detailed working brief for the `Ultimateweb` project. Use it as the implementation-oriented counterpart to `README.md`. There was no existing `AGENTS.md` or `AGENT.md` in the repo before this file was added.

## Project Summary

Ultimateweb is a local website builder stack. A shared Node server handles auth, build orchestration, persistence, static serving, and editor/site APIs. Two entrypoints exist:

- `backend/server.mjs` serves the main `frontend/` app.
- `builder-portal/server.mjs` serves `builder-portal/public/` using the same server logic.

The actual server implementation lives in `shared/builder-server.mjs`.

## Source Of Truth

- For architecture and behavior, start with `shared/builder-server.mjs`.
- For auth/session/database behavior, check `shared/supabase.mjs`.
- For user-facing builder behavior, check `frontend/index.html` and `frontend/app.js`.
- For editor behavior, check `frontend/editor.html`, `frontend/editor.css`, and `frontend/editor.js`.
- For persistence and access policy, check `supabase/migrations/20260317193000_auth_and_generated_sites.sql`.
- For generation pipeline behavior, check `skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs`.

## Important Directories

- `shared/`: server and Supabase integration
- `frontend/`: main builder UI plus in-browser editor
- `builder-portal/`: alternate static shell using the same server
- `generated-sites/`: runtime outputs and local sample/public site artifacts
- `skills/fal-futuristic-website-builder/`: website generation pipeline script
- `supabase/`: local DB/auth config and migrations

## Current Architecture

- `backend/server.mjs` and `builder-portal/server.mjs` are minimal wrappers.
- Both wrappers call `startBuilderServer(...)` from `shared/builder-server.mjs`.
- The shared server:
  - loads `.env` from the repo root
  - applies CORS based on `ULTIMATEWEB_ALLOWED_ORIGINS`
  - exposes auth/session/build/gallery/site APIs
  - spawns the FAL pipeline process
  - persists jobs and sites into Supabase
  - serves `frontend/` or `builder-portal/public/`
  - protects non-public `/generated-sites/*` paths per authenticated user

## Runtime Model

- Builds require authentication unless you are only viewing public sample content.
- Supabase is used for email/password auth, Google OAuth, HTTP-only session cookies, `build_jobs` persistence, and `generated_sites` persistence.
- The server spawns `skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs` to create sites.
- Generated site files are stored under `generated-sites/<slug>/`.
- Most `/generated-sites/*` routes are private and checked against the authenticated user before being served.

## Build Inputs Supported Today

- `topic`
- `pageMode`: `conversion`, `editorial`, `hybrid`
- `existingWebsite`
- color overrides
- uploaded or reused start image
- uploaded or reused end image
- uploaded or reused video
- prompt overrides
- `changeRequest`
- `editSourceSlug`
- `contentOverrides` from the editor

## Current User Flows

- Sign in or sign up from the portal.
- Launch a build with topic, mode, optional source URL, palette, media, and prompt overrides.
- Poll build job state via `/api/jobs/:id`.
- View completed results in the private gallery.
- Open a generated site in the inline editor with `editor.html?slug=<slug>`.
- Rebuild from an existing site while reusing current media or replacing selected assets.
- Delete a generated site through the site deletion endpoint.

## Main API Surface

- `GET /api/config`
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

## Data And Access Model

- `build_jobs` stores queue/running/completed/failed status, logs, error, site URL, thumbnail URL, metadata URL, and timestamps.
- `generated_sites` stores slug, title, topic, page mode, color palette, site/media metadata, prompt overrides, edit lineage, soft-deletion timestamp, and timestamps.
- Both tables have row-level security enabled.
- The app additionally checks authenticated ownership before serving private generated-site files from disk.
- Some sample slugs are hard-coded as public in `PUBLIC_SAMPLE_SLUGS` inside `shared/builder-server.mjs`.

## Environment

Expected repo-root `.env` keys:

- `HOST`
- `PORT`
- `FAL_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ULTIMATEWEB_ALLOWED_ORIGINS`
- optional `ULTIMATEWEB_API_BASE`

Notes:

- Missing Supabase keys disable auth-backed flows.
- Missing `FAL_KEY` blocks builds that need generated video, but not builds that already supply a video asset or URL.
- The server loads `.env` itself from the repo root.

## Working Conventions

- Treat `generated-sites/` as real project/runtime state. Do not delete or rewrite it casually.
- Expect untracked generated output in the worktree.
- Prefer reading current server/frontend code over inferring behavior from docs.
- If a route or access rule matters, verify it in `shared/builder-server.mjs` before changing related code.
- If a change touches persistence or auth, review the Supabase helper and migration together.

## Editing Guidance

- Do not assume `generated-sites/` is disposable. It contains user/runtime output and sample artifacts.
- Check for untracked changes before large edits; generated content may be intentionally present.
- If changing auth, gallery, editor, or generated-site access rules, review both `shared/builder-server.mjs` and `shared/supabase.mjs`.
- If changing the builder UX, inspect both `frontend/index.html` and `frontend/app.js`.
- If changing editor behavior, inspect `frontend/editor.html`, `frontend/editor.css`, and `frontend/editor.js`.

## Documentation Split

- `README.md` is the human-facing overview: description, features, setup, routes, and operational context.
- `AGENTS.md` is the detailed working memory file: architecture, source-of-truth files, flows, access model, and implementation guidance.
