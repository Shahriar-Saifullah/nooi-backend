-- 20261122_factory_files.sql
-- Phase 1 of working with factories (client feedback, Nov 2026):
--   1. drawings (DWG / DXF / PDF) on listings and on order lines
--   2. a factory spec on each order line: the options a factory needs to
--      build it (materials, doors, hinges, handles, fillers ...), all optional
--      free text — guidance, never enforced
--   3. size ranges and a note on listings ("depth usually 55–60 cm"),
--      shown to shoppers as guidance the factory confirms
-- Files live in the PRIVATE bucket "factory-drawings"; the API hands out
-- short-lived signed links. Browsers upload straight to storage with a signed
-- upload URL, so large DWGs never pass through our servers.
-- Safe to run more than once.

BEGIN;

ALTER TABLE public.products
  -- [{ "path", "name", "size", "kind", "uploaded_at", "uploaded_by", "role" }]
  ADD COLUMN IF NOT EXISTS drawings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { "width": { "min", "max" }, "depth": {...}, "height": {...} } in cm
  ADD COLUMN IF NOT EXISTS size_ranges jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS size_note   text;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS drawings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { "fields": { carcass, back, doors, ... }, "updated_at", "updated_by" }
  ADD COLUMN IF NOT EXISTS factory_spec jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_drawings_is_array') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_drawings_is_array CHECK (jsonb_typeof(drawings) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_drawings_is_array') THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_drawings_is_array CHECK (jsonb_typeof(drawings) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_size_note_len') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_size_note_len CHECK (size_note IS NULL OR length(size_note) <= 500);
  END IF;
END $$;

-- Private: no public URLs, no storage policies — only the API (service role)
-- signs uploads and downloads. 50 MB per file (the Supabase upload ceiling);
-- the file type is checked by the API when it signs the upload.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('factory-drawings', 'factory-drawings', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 52428800;

COMMIT;
