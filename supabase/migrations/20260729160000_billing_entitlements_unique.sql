-- Stripe explicitly documents that a webhook event can be delivered more
-- than once (retries on timeout, non-2xx response, etc.), so the handler
-- must be idempotent. stripe-webhook.js's checkout.session.completed case
-- POSTs to billing_entitlements with Prefer: resolution=merge-duplicates,
-- but with no unique constraint besides the auto-generated id primary key,
-- there was nothing for PostgREST to conflict against — every retry
-- inserted a brand new row instead of updating the existing one.
--
-- One row per (user, plan) matches how activatePlus() already reads/writes
-- this table (filtered by user_id + plan).
--
-- Defensive: if this exact duplication bug already produced duplicate
-- rows before this migration existed, adding the constraint would fail
-- outright. Keep only the most recent row per (user_id, plan) first.
delete from public.billing_entitlements a
using public.billing_entitlements b
where a.user_id = b.user_id
  and a.plan = b.plan
  and (a.created_at, a.id) < (b.created_at, b.id);

alter table public.billing_entitlements drop constraint if exists billing_entitlements_user_plan_key;
alter table public.billing_entitlements add constraint billing_entitlements_user_plan_key unique (user_id, plan);
