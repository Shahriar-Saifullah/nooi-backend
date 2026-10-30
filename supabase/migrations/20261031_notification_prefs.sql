-- 20261031_notification_prefs.sql
-- Which in-app notifications each person wants, set on Profile → Notifications.
--   { "shipment": false, "support": true, ... }   missing key = on
-- Notifications marked essential (refunds, cancellations, payment problems,
-- account decisions) are sent regardless. Safe to run more than once.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
