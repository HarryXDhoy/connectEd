# connectEd production setup

The public website is deployed at `https://cntd-projects.vercel.app`.
Complete these steps in order.

## 1. Apply the Supabase schema and security policies

1. Open Supabase → SQL Editor.
2. Open `supabase-schema.sql` in this repository.
3. Copy the entire file into a new SQL query.
4. Run it.

The file is safe to rerun. It creates the tables, replaces the Row Level
Security policies, hides billing identifiers, prevents members from granting
themselves Plus status, and installs the protected project-boost function.

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
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRIORITY_PRICE_ID=price_...
PUBLIC_SITE_URL=https://cntd-projects.vercel.app
```

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
7. Complete a Stripe test subscription and activate the boost on one owned project.
