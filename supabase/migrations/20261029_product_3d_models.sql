-- 20261029_product_3d_models.sql
-- ---------------------------------------------------------------------------
-- 3D models for vendor listings (photos → GLB).
--
-- One row per attempt to produce a GLB for a product. The worker in
-- services/model3d moves a job through:
--
--   queued → processing → review → approved   (GLB published on the listing)
--                               ↘ rejected     (admin didn't like it; retry)
--            ↘ failed                          (provider error; retry)
--
-- Publishing writes products.specs_json.model_url, which the product page and
-- marketplace already read — nothing else on the shop side has to change.
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_model_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','processing','review','approved','rejected','failed','cancelled')),
  provider         text NOT NULL DEFAULT 'tripo',      -- tripo | mock | manual
  mode             text NOT NULL DEFAULT 'multiview'
                   CHECK (mode IN ('single','multiview','manual')),
  -- [{ "view": "front"|"left"|"back"|"right", "url": "https://…" }]
  source_images    jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_task_id text,
  progress         int  NOT NULL DEFAULT 0,
  glb_url          text,          -- our stored copy (vendor-assets bucket)
  glb_path         text,
  glb_bytes        bigint,
  error            text,
  attempts         int  NOT NULL DEFAULT 0,
  next_poll_at     timestamptz NOT NULL DEFAULT now(),
  review_note      text,
  requested_by     uuid,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_jobs_product ON public.product_model_jobs(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_jobs_work    ON public.product_model_jobs(status, next_poll_at)
  WHERE status IN ('queued','processing');

-- At most one live attempt per product, so two clicks can't pay for two models.
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_jobs_one_active
  ON public.product_model_jobs(product_id)
  WHERE status IN ('queued','processing','review');

-- Backend (service role) only.
ALTER TABLE public.product_model_jobs ENABLE ROW LEVEL SECURITY;
