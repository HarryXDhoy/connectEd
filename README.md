# connectEd

A project-collaboration platform: people publish projects, apply to join others', and find each other on a live 3D globe based on approximate location.

Live at **https://cntd-projects.vercel.app**

## Stack

- **Frontend:** static HTML/CSS/JS, no build step, no framework. Three.js (via CDN) powers the 3D globe.
- **Backend:** [Supabase](https://supabase.com) — Postgres, Auth, and PostgREST as the API layer. All data access happens client-side against Supabase using the anon key; Row Level Security policies enforce who can read/write what.
- **Hosting:** [Vercel](https://vercel.com), auto-deploying from `main` on every push. `vercel.json` defines URL rewrites and security headers (CSP, X-Frame-Options, etc).
- **Geocoding:** [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap) for turning a typed city/region into coordinates.

## Pages

- `connected-app.html` / `connected-app.js` / `connected-app.css` — landing page: the member globe, project discovery feed, and account creation.
- `project-hub.html` / `project-hub.js` / `project-hub.css` — signed-in workspace: creating/editing projects, managing applications, profile settings.

## Local development

There's no build step — just serve the directory and open it:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000/connected-app.html`. Note that Vercel's response headers (CSP, etc.) aren't sent by a plain static server, so header-dependent behavior should be double-checked after deploy.

## Deployment

Push to `main` — Vercel picks it up automatically. No manual build or deploy step.
