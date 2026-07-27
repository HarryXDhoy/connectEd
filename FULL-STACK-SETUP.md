# connectEd production setup

The public website is deployed at `https://cntd-projects.vercel.app`.
Complete these steps in order.

## 1. Database migrations (automated)

Schema changes live in `supabase/migrations/` and apply themselves. A
GitHub Action (`.github/workflows/supabase-migrations.yml`) runs
`supabase db push` against the live project on every push to `main` that
touches `supabase/migrations/**` — pushing code and migrating the database
are no longer two separate manual steps.

One-time setup, in this GitHub repo's Settings → Secrets and variables →
Actions:

```text
SUPABASE_ACCESS_TOKEN   Supabase → Account → Access Tokens → generate one
SUPABASE_DB_PASSWORD    Supabase → Project Settings → Database → Database password
                        (reset it there if you don't have it)
```

Neither secret is visible to the deployed app — they only exist inside the
GitHub Action's environment, never in Vercel or client code.

To add a schema change: create a new file in `supabase/migrations/` named
`YYYYMMDDHHMMSS_description.sql` and push it. Don't edit old migration
files — the CLI tracks which ones already ran, so an edited file won't
re-apply.

To run it by hand instead (e.g. before the Action is set up, or to check
something immediately): open the newest file in `supabase/migrations/` in
the Supabase SQL Editor and run it directly — every migration in this
project is written to be safe to rerun.

## 2. Public Supabase browser configuration

`app-config.js` contains only the public project URL and publishable key:

```js
window.CONNECTED_CONFIG = {
  url: 'https://YOUR_PROJECT_REF.supabase.co',
  anonKey: 'sb_publishable_...'
};
```

Never put an `sb_secret_...` key in this file.

## 3. Supabase Auth URL configuration

Supabase → Authentication → URL Configuration:

```text
Site URL
https://cntd-projects.vercel.app
```

Add these redirect URLs:

```text
https://cntd-projects.vercel.app/
https://cntd-projects.vercel.app/landing.html
https://cntd-projects.vercel.app/connected-app.html
https://cntd-projects.vercel.app/project-hub.html
https://cntd-projects.vercel.app/project-hub
```

Enable Email and Google under Authentication → Sign In / Providers.

## 4. Google OAuth, Calendar, and Meet

Google Auth Platform → Clients → Create Client → Web application.

Authorized JavaScript origin:

```text
https://cntd-projects.vercel.app
```

Authorized redirect URI:

```text
https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
```

Copy the Google Client ID and Client Secret into the Google provider in
Supabase. Keep **Skip nonce checks** off.

In Google Cloud:

1. Enable Google Calendar API.
2. Google Auth Platform → Data Access: add
   `https://www.googleapis.com/auth/calendar.events`.
3. While the app is in Testing, add each permitted account under
   Google Auth Platform → Audience → Test users.

Meet links are created through Calendar events; no separate Meet API is needed.

The embedded Open Design preview cannot complete Google OAuth inside its iframe.
Its Google buttons intentionally open the production project hub in a new tab,
then continue the same Supabase sign-in flow there. Keep
`window.CONNECTED_CONFIG.publicSiteUrl` pointed at the canonical deployed site.

## 5. Vercel environment variables

Add these under Vercel → cntd → Settings → Environment Variables:

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRIORITY_PRICE_ID=price_...
PUBLIC_SITE_URL=https://cntd-projects.vercel.app
```

`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are the same values already entered
into Supabase's Google provider in step 4 — copy them here too. The server
uses them to exchange a member's stored Google refresh token for a fresh
Calendar access token on each interview request, so members only ever
connect Google once instead of re-authenticating every time their access
token expires (about an hour).

`SUPABASE_SERVICE_ROLE_KEY`, Stripe secrets, and the Google Client Secret are
server-only. Never put them in HTML, `app-config.js`, GitHub, screenshots, or
chat.

Project cover images are resized and compressed in the browser before they are
saved with the authenticated project record. No external image host or
additional storage bucket is required.

## 6. Stripe subscription

Create one recurring Stripe product:

```text
Name: connectEd Plus
Price: $6 USD monthly
```

Copy its price ID to `STRIPE_PRIORITY_PRICE_ID`.

Create a webhook endpoint:

```text
https://cntd-projects.vercel.app/api/stripe-webhook
```

Subscribe it to:

```text
checkout.session.completed
customer.subscription.updated
customer.subscription.deleted
```

Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.

## 7. Final test

1. Sign in with a Google account listed as a test user.
2. Save a skills profile.
3. Publish a project with an application question.
4. Sign in as a second test user and apply.
5. Review that applicant from the project owner account.
6. Schedule an interview and confirm both Calendar and Meet links.
7. Accept the applicant, then confirm both accounts can review verified project participants.
8. Pause applications from My projects and confirm the project stays visible but no longer accepts a new request.
9. Complete a Stripe test subscription and activate the boost on one owned project.
