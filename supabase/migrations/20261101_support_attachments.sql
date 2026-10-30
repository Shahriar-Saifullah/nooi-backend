-- 20261101_support_attachments.sql
-- Photos on support tickets (a damaged item, a wrong colour, a delivery note).
--   * support_messages.attachments: [{ "path", "name", "size", "width", "height" }]
--   * a message may now be photos only, so the body can be empty
--   * a PRIVATE storage bucket; the API hands out short-lived signed links
-- Safe to run more than once.

ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
DECLARE c text;
BEGIN
  -- the original CHECK required 1–5000 characters; allow 0 (photo-only)
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.support_messages'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%length(body)%'
  LOOP
    EXECUTE format('ALTER TABLE public.support_messages DROP CONSTRAINT %I', c);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_messages_body_or_photo') THEN
    ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_body_or_photo
      CHECK (length(body) <= 5000 AND (length(body) >= 1 OR jsonb_array_length(attachments) >= 1));
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('support-attachments', 'support-attachments', false, 5242880, ARRAY['image/jpeg'])
ON CONFLICT (id) DO NOTHING;
