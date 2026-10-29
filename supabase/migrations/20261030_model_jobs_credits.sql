-- 20261030_model_jobs_credits.sql
-- Tripo is pay-as-you-go: record what each model cost, and when the provider
-- actually started (a job can wait in the queue for credits; the 45-minute
-- give-up clock starts when the provider starts, not when it was queued).
-- Safe to run more than once.

ALTER TABLE public.product_model_jobs ADD COLUMN IF NOT EXISTS credits_used numeric;
ALTER TABLE public.product_model_jobs ADD COLUMN IF NOT EXISTS started_at   timestamptz;
