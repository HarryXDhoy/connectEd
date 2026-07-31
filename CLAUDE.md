# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

connectEd is a project-collaboration platform: people publish projects, apply to join others', and find each other on a 3D globe. Live at https://cntd-projects.vercel.app.

There is **no build step, no package.json, no framework, and no test suite.** The site is hand-written static HTML/CSS/ES-module JS served directly by Vercel, plus a handful of Vercel serverless functions in `api/`. Third-party libraries (Supabase JS, Three.js, topojson) are `import()`ed from `cdn.jsdelivr.net` at runtime — never install or bundle them.

## Commands

Serve the site locally (any static server works):

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/connected-app.html`. Caveats of local serving:
- `vercel.json` headers (CSP, etc.) are **not** applied, so header-dependent behavior must be re-checked after deploy.
- `/api/*` functions don't run — the client falls back to error paths. `isEmbeddedPreview()` in [supabase-client.js](supabase-client.js) treats `localhost`, `file:`, and any iframe as a preview and routes Google OAuth to the production hub in a new tab instead of completing it in place.

Deploy: push to `main`. Vercel auto-deploys; the `supabase/migrations/**` GitHub Action pushes any new migrations.

## Architecture

### Two pages, deliberately duplicated

- [connected-app.html](connected-app.html) / `.js` / `.css` — public landing: 3D member globe, project discovery feed, sign-up.
- [project-hub.html](project-hub.html) / `.js` / `.css` — signed-in workspace: tab panels for discover / owned projects / applicants / sent requests / messages / profile, all in one HTML file with `hidden` toggled.

The two JS files share a large amount of near-identical code (helpers, tag encoding, image optimization, geocoding, project card rendering) **by copy, not by import**. Only [supabase-client.js](supabase-client.js) is genuinely shared. When changing shared-looking logic, grep the other file for the same code and update both, or the pages will drift.

Both pages load `app-config.js` (classic script setting `window.CONNECTED_CONFIG`) before the module script. Asset URLs carry `?v=YYYYMMDD` cache-busting query strings — bump them when changing a file whose old version would break the new one.

### Data access

Nearly all reads and writes go **client-side straight to Supabase** with the publishable (anon) key. Security is enforced entirely in Postgres, in two layers:

1. **RLS policies** decide which *rows* a user can see or touch.
2. **Column-level grants** decide which *columns* can ever be written — e.g. `applications` only grants `update (status, updated_at)`, `messages` only grants `update (read_at)`, and `projects` deliberately omits `boost_until` so a boost can only be set through the `activate_plus_boost` RPC.

Consequence: adding a column to a table is not enough. If the client needs to read or write it, it must also be added to the `grant select (...)` / `grant update (...)` lists near the end of the initial schema — a missed grant fails silently at the privilege level rather than at RLS, which has bitten this codebase before (see the comment above the `profiles` grants).

Some queries go through security-definer RPCs instead of direct table access, to expose aggregates without exposing rows: `project_seat_counts()`, `public_team_connections()`, `activate_plus_boost(target_project)`.

`profiles` also holds `google_refresh_token`, intentionally excluded from every client grant — service-role only.

### Migrations

`supabase/migrations/YYYYMMDDHHMMSS_description.sql`. Applied automatically by [.github/workflows/supabase-migrations.yml](.github/workflows/supabase-migrations.yml) on any push to `main` touching that directory. Rules:

- Never edit an already-applied migration — the CLI tracks which ran and won't re-apply an edited file. Add a new one.
- Every migration is written to be **safe to rerun** (`create ... if not exists`, `drop policy if exists` before `create policy`, guarded `alter publication`). Keep new ones that way; they're sometimes pasted into the SQL editor by hand.
- `supabase/config.toml` is minimal on purpose — this repo never runs `supabase start` locally.

### Serverless functions (`api/`)

Vercel functions, ESM, zero dependencies (Stripe is called via raw `fetch` against `api.stripe.com`, Google via `googleapis.com`). Shared helpers live in [api/_supabase.js](api/_supabase.js): `json()`, `requireSupabaseUser()` (verifies the caller's bearer token against Supabase `/auth/v1/user`), `userQuery()`, `validUuid()`.

Every handler wraps its body in try/catch and always returns JSON — the client's `safeJson()` exists because a crashing function otherwise yields "Unexpected end of JSON input". Preserve that shape in new endpoints.

Endpoints: `google-calendar` (schedules interviews, creates Calendar event + Meet link, exchanges the stored refresh token for an access token), `store-google-token`, `create-checkout-session`, `create-portal-session`, `payments-status` (public, returns only a boolean), `stripe-webhook` (raw body, manual HMAC signature verification, `bodyParser: false`).

Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, Stripe keys, Google client secret) live in Vercel env vars only — never in `app-config.js`, HTML, or client JS. `app-config.js` contains only the public URL and publishable key.

### Tag-prefix encoding (important quirk)

`projects.tags` is a plain `text[]` that doubles as a metadata channel. Sentinel entries encode non-tag data instead of new columns:

- `__image__:<data-url>` — the project cover image (resized/compressed in-browser by `optimizeProjectImage()` to ~180 KB before saving; no storage bucket is used)
- `__location__:...`, `__link__:...` (hub only)
- `__applications_paused__` — the project stays visible and `status = 'open'` but stops accepting requests

Anything rendering user-facing tags must filter these out (`projectTags()`), and anything writing tags must preserve them.

### Client-side security habits

- All interpolated values go through `escapeHtml()` — the pages build markup with template strings, so this is the only XSS defense.
- User-supplied URLs go through `safeExternalUrl()` (http/https only) before becoming an `href`; `escapeHtml` alone doesn't stop `javascript:`.
- The CSP in [vercel.json](vercel.json) whitelists exactly `cdn.jsdelivr.net`, `*.supabase.co`, `*.googleapis.com`, `nominatim.openstreetmap.org`, and `lh3.googleusercontent.com`. Any new external origin must be added there or it will be blocked in production only.

### Other notes

- Member location: `profiles.location_{label,latitude,longitude}` is the single source of truth (an earlier design mirrored it into auth metadata and project tags — don't reintroduce that). Coordinates are rounded client-side before being sent, and validated with `Number.isFinite` rather than coercion so a missing value isn't read as 0°,0°. Geocoding is Nominatim.
- Realtime: the hub subscribes to Supabase channels for request updates and messages (`messages` is in the `supabase_realtime` publication).
- Discovery ordering is `boost_until desc nulls last` — the paid "Plus" boost.
- Setup/ops runbook (Supabase auth URLs, Google OAuth + Calendar scopes, Stripe product and webhook, Vercel env vars, manual end-to-end test list) lives in [FULL-STACK-SETUP.md](FULL-STACK-SETUP.md).

## Visual system

Dark, Supabase-like posture; tokens and rules in [brand-spec.md](brand-spec.md). Near-black surfaces separated by 1px borders rather than shadows, emerald accent used only for the brand mark / primary action / active state / status — never as a large wash. Pills for primary actions and tabs, 6px radius for secondary controls. Transforms are dropped under `prefers-reduced-motion`.

## Style

Comments in this codebase explain *why* — they routinely record the bug a piece of code exists to prevent, and are often several sentences long. Match that when the reasoning isn't obvious from the code; don't add comments that restate it.
