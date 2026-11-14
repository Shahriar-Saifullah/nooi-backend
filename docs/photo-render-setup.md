# Photo render — setup

Until these are done, the "Photo render" button tells people it isn't
available yet; nothing else is affected.

## 1. Database

Run `supabase/migrations/20261114_render_jobs.sql` in the Supabase SQL editor.

## 2. Worker image

Push any branch that changes `render-worker/` (or re-run the **render-worker**
workflow from the Actions tab).
It publishes `ghcr.io/shahriar-saifullah/nooi-render-worker:latest`.

The package starts **private**. Either make it public (GitHub → Packages →
nooi-render-worker → Package settings → Change visibility), or add a GitHub
token with `read:packages` to RunPod as a container registry credential.

## 3. RunPod serverless endpoint

RunPod → Serverless → New Endpoint → Custom (Docker image):

| Setting | Value |
|---|---|
| Image | `ghcr.io/shahriar-saifullah/nooi-render-worker:latest` |
| GPU | 24 GB class (RTX 4090 / L4 / A5000) |
| Min workers (active) | 0 — nothing is paid while no one renders |
| Max workers | 2 |
| Idle timeout | 5 s |
| Execution timeout | 420 s |
| FlashBoot | on (faster starts) |
| Container disk | 15 GB |

Then copy the endpoint ID and create an API key (Settings → API Keys).

## 4. Railway environment variables (backend)

| Variable | Value |
|---|---|
| `RUNPOD_API_KEY` | the API key |
| `RUNPOD_RENDER_ENDPOINT_ID` | the endpoint ID |
| `RENDER_WEBHOOK_SECRET` | a long random string (e.g. `openssl rand -hex 32`) |
| `RENDER_CALLBACK_BASE_URL` | this API's public URL, e.g. `https://api.example.com` |
| `RENDER_DAILY_PER_USER` | 20 |
| `RENDER_MONTHLY_CAP_USD` | 50 |
| `RENDER_USD_PER_SECOND` | the endpoint's per-second GPU price from RunPod |

## 5. Storage

Scenes and images go in the existing `nooi-projects` bucket
(`render-scenes/…` and `renders/…`). If the bucket limits file types, allow
`application/gzip` and `image/jpeg`; if it limits size, allow at least 300 MB.

## Limits while it's free

- 20 photo renders per person per day, at most 2 at a time
- all renders pause once the month's GPU spend reaches the cap
- each render is stopped after 4 minutes (standard) or 5 minutes (4K)

Every job records its GPU seconds and cost in `render_jobs`, ready for
charging later.
