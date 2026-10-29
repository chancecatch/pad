# PAD Frontend

Next.js frontend for https://pineatdawn.me.

## Run

```bash
conda activate pad
cd "$HOME/Research/Pad/web/frontend"
npm run dev
```

Local URL: http://localhost:3000

## Build

```bash
npm run build
```

## Notes

- App Router pages live in `src/app`.
- Shared UI lives in `src/components`.
- Notion integration lives in `src/lib/notion.ts`.
- The English Tutor uses local service URLs from `.env.local`; do not add hosted API keys to the UI.
- WebXR static assets live under `public/xr/wedding-exhibition-needle`.
