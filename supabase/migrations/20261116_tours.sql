-- 360° tours (step 3b): one panorama per room, rendered on the GPU worker,
-- shown in a viewer with room-to-room pins and a floor-plan map.
--
-- A tour is a set of panorama render jobs (render_jobs.tour_id) plus what the
-- viewer needs: where each panorama was taken, which rooms connect, and the
-- outline of the plan for the map. Shared by a link (share_token), like
-- shared projects.

create table if not exists public.tours (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  title         text not null default '360° tour',
  quality       text not null default 'standard' check (quality in ('standard', 'high')),
  status        text not null default 'uploading'
                check (status in ('uploading', 'rendering', 'done', 'partial', 'failed', 'cancelled')),
  -- [{ id, roomId, name, position: [x,y,z], links: [{ to, at: [x,z] }] }]
  nodes         jsonb not null,
  -- { rooms: [{ id, name, poly: [[x,z]...] }], bounds: [minX, minZ, maxX, maxZ] }
  plan          jsonb not null,
  scene_path    text not null,
  share_token   text unique,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists tours_project_idx on public.tours (project_id, created_at desc);

alter table public.render_jobs add column if not exists tour_id uuid references public.tours(id) on delete cascade;
alter table public.render_jobs add column if not exists node_id text;
create index if not exists render_jobs_tour_idx on public.render_jobs (tour_id) where tour_id is not null;

alter table public.tours enable row level security;
drop policy if exists "tours: owner reads" on public.tours;
create policy "tours: owner reads" on public.tours for select using (auth.uid() = user_id);
