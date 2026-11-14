-- Photo renders (step 3a): one row per image rendered on the GPU worker.
--
-- The browser uploads the scene (gzipped GLB) to storage, the backend sends
-- the job to RunPod, and RunPod calls back when it's done. Cost is recorded
-- from the first render so it can be charged for later.
--
-- Files (bucket nooi-projects):
--   render-scenes/<user>/<sha256>.glb.gz     the scene; re-used when the same
--                                            scene is rendered from another angle
--   renders/<user>/<project>/<job>.jpg       the result

create table if not exists public.render_jobs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null default 'image' check (kind in ('image', 'panorama', 'video')),
  quality       text not null default 'standard' check (quality in ('standard', 'high')),
  status        text not null default 'uploading'
                check (status in ('uploading', 'queued', 'running', 'done', 'failed', 'cancelled')),
  spec          jsonb not null,
  scene_path    text not null,
  result_path   text,
  width         int,
  height        int,
  provider_job_id text,
  gpu_seconds   numeric(10, 2) not null default 0,
  cost_usd      numeric(10, 4) not null default 0,
  error         text,
  stats         jsonb,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

create index if not exists render_jobs_project_idx on public.render_jobs (project_id, created_at desc);
create index if not exists render_jobs_user_day_idx on public.render_jobs (user_id, created_at desc);
create index if not exists render_jobs_month_idx on public.render_jobs (created_at) where status in ('queued', 'running', 'done');
create unique index if not exists render_jobs_provider_idx on public.render_jobs (provider_job_id) where provider_job_id is not null;

-- The backend reads and writes with the service role; people only ever read
-- their own rows (the API is the way in).
alter table public.render_jobs enable row level security;

drop policy if exists "render_jobs: owner reads" on public.render_jobs;
create policy "render_jobs: owner reads" on public.render_jobs
  for select using (auth.uid() = user_id);
