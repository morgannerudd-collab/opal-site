-- Billing / Stripe webhook support: profile columns, subscription_events, lookup helper, relaxed checks

-- ---------------------------------------------------------------------------
-- Lookup auth user id by email (service_role only) — webhooks have no session
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lookup_user_id_by_email(lookup_email text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT id FROM auth.users WHERE lower(trim(email)) = lower(trim(lookup_email)) LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.lookup_user_id_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_user_id_by_email(text) TO service_role;

-- ---------------------------------------------------------------------------
-- profiles — new billing columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'active';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS account_status text DEFAULT 'active';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS grace_period_end timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS suspension_date timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deletion_scheduled_date timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS billing_interval text DEFAULT 'monthly';

COMMENT ON COLUMN public.profiles.payment_status IS 'Billing payment state (e.g. active, past_due).';
COMMENT ON COLUMN public.profiles.account_status IS 'Account access state (e.g. active, cancelled).';
COMMENT ON COLUMN public.profiles.billing_interval IS 'monthly or annual from Stripe.';

-- Relax subscription_status to include cancel_pending and British spelling
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_subscription_status_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_subscription_status_check
  CHECK (
    subscription_status IS NULL
    OR subscription_status IN (
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'cancelled',
      'cancel_pending',
      'unpaid',
      'paused'
    )
  );

-- ---------------------------------------------------------------------------
-- subscription_events — extra columns + event types for webhooks
-- ---------------------------------------------------------------------------
ALTER TABLE public.subscription_events ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE public.subscription_events ADD COLUMN IF NOT EXISTS billing_interval text;
-- Amounts use existing amount_cents (Stripe amounts in cents).

ALTER TABLE public.subscription_events DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;
ALTER TABLE public.subscription_events ADD CONSTRAINT subscription_events_event_type_check
  CHECK (
    event_type IN (
      'trial_started',
      'trial_converted',
      'trial_cancelled',
      'plan_upgraded',
      'plan_downgraded',
      'payment_succeeded',
      'payment_failed',
      'subscription_cancelled',
      'subscription_reactivated',
      'checkout_completed',
      'subscription_updated'
    )
  );
