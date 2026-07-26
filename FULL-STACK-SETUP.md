# connectEd setup

## 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, create a new query, paste the entire contents of `supabase-schema.sql`, and run it.
3. Open **Project Settings → API** and copy:
   - **Project URL**
   - ** anon / public key**
4. Put those two values in `app-config.js`:

```js
window.CONNECTED_CONFIG = {
  url: 'https://YOUR_PROJECT_REF.supabase.co',
  anonKey: 'YOUR_SUPABASE_ANON_KEY'
};
```

Never put the Supabase service-role key in `app-config.js` or in browser code.

## 2. Supabase authentication

In **Authentication → Providers**:

- Enable **Email**.
- Enable **Google** after completing the Google Cloud steps below.

In **Authentication → URL Configuration**, set:

- Site URL: `https://cntd-projects.vercel.app`
- Redirect URLs:
  - `https://cntd-projects.vercel.app/landing.html`
  - `https://cntd-projects.vercel.app/project-hub.html`
  - `http://localhost:3000/connected-app.html` for local testing

## 3. Google sign-in, Calendar, and Meet

1. Open [Google Cloud Console](https://console.cloud.google.com), create or select a project, and enable **Google Calendar API**.
2. Configure the OAuth consent screen. Add `cntd-projects.vercel.app` as an authorized domain.
3. Create **Credentials → OAuth client ID → Web application**.
4. In the OAuth client, add this authorized redirect URI, replacing `YOUR_PROJECT_REF` with the Supabase project reference:

   `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`

5. Copy the Google OAuth **Client ID** and **Client Secret** into Supabase under **Authentication → Providers → Google**.
6. Save the provider. The app requests the Calendar Events scope during Google sign-in, which the project hub uses to create a Google Calendar event with a Google Meet link.

Google OAuth credentials belong in Supabase’s provider settings. Do not commit the Google client secret or place it in `app-config.js`.

## 4. Vercel

Add the values from `.env.example` to the Vercel project. At minimum, the server-side scheduling and billing endpoints need:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRIORITY_PRICE_ID`
- `STRIPE_BOOST_PRICE_ID`
- `PUBLIC_SITE_URL=https://cntd-projects.vercel.app`

Redeploy after saving the variables. The public Supabase URL and anon key still belong in `app-config.js` because these static HTML pages load in the browser.

## 5. Button and route map

- `/` → landing page
- `/landing.html` → landing page
- `/collaboration-landing` → landing page compatibility route
- `/project-hub` → project hub
- `/project-hub.html` → project hub

The Vercel rewrites point to `connected-app.html`, which is the actual landing file in this project.

## 6. Stripe plans

- Free: browse, profile, applications, interviews.
- connectEd Plus: `$6/month`, combining participant Priority Match with initiator project visibility benefits.
- Project Boost: `$5` one-time project promotion.

Create the products and prices in Stripe, set the corresponding Price IDs in Vercel, and register `/api/stripe-webhook` for checkout and subscription events.
