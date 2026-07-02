-- =============================================================
-- MIGRATION 079 — WIDEN STRIPE ID COLUMNS
--
-- payments.stripe_checkout_session was varchar(64), but real Stripe
-- Checkout Session IDs ("cs_live_…"/"cs_test_…") are ~66 characters,
-- so the post-create UPDATE that stores the session id would fail on
-- EVERY real checkout ("value too long for type character varying(64)")
-- — the payer got a 500 and the row was marked failed while the Stripe
-- session stayed open. The test suite never caught it because the fake
-- Stripe returns short ids. Stripe documents no maximum id length and
-- advises against assuming one, so all three linkage columns become
-- text (a metadata-only change in Postgres — no table rewrite, safe on
-- the live database).
-- =============================================================

BEGIN;

ALTER TABLE public.payments
  ALTER COLUMN stripe_checkout_session TYPE text,
  ALTER COLUMN stripe_payment_intent   TYPE text,
  ALTER COLUMN stripe_charge_id        TYPE text;

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 79, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
