# PAD Web

Website source for PAD - Pine At Dawn.

Live site: https://pineatdawn.me

## Current Runtime

| Area | Stack |
| --- | --- |
| Frontend | Next.js 16, React 19, TypeScript |
| Backend | Express 5, MongoDB |
| Content | Notion databases and pages |
| Deploy | Vercel frontend, Heroku backend |
| Tutor runtime | Official Mac Ollama chat plus MLX Audio, authenticated gateway, and cloudflared LaunchAgents; direct gateway and Vercel tutor routes are live and verified |

## Local Development

The Node/npm runtime and the `pad` Conda environment were restored and verified
on July 28. Run:

```bash
conda activate pad
cd "$HOME/Research/Pad/web"
npm run dev
```

Frontend: http://localhost:3000
Backend: http://localhost:4000

## Build Check

```bash
npm --prefix frontend run build
npm --prefix backend run build
```

## Active Features

- Notion-driven PAD projects and Mj portfolio pages.
- Guestbook notes through the backend API.
- English Tutor at `/tutor`, backed by verified Mac-hosted inference through an authenticated Cloudflare gateway and Vercel Next routes.
- Wedding Exhibition XR wrapper at `/xr/wedding-exhibition`; direct route is deployable, but keep it unpromoted until media/privacy polish is complete.

Tutor details live in `Docs/local-first-english-tutor.md`.
