# Running the dev servers locally

## Backend (FastAPI)

```bash
PORT=8000 ./scripts/run-api.sh
```

- Loads `.env` (needs `DATABASE_URL` pointing at your local Postgres).
- Runs on `http://localhost:8000`.
- Docs: `http://localhost:8000/docs`
- `PORT=8000` matters — the frontend's `VITE_API_BASE_URL` (see `ui-reference/.env.development`) points at 8000, not the script's own default of 8007.

## Frontend (Vite/React)

```bash
cd ui-reference
npm run dev
```

- Runs on `http://localhost:8080` (fixed via `--strictPort` in `package.json`).
- Requires the backend already running on port 8000 for API calls to resolve.

## Quick health check

```bash
curl -s -o /dev/null -w "backend: %{http_code}\n" http://localhost:8000/openapi.json
curl -s -o /dev/null -w "frontend: %{http_code}\n" http://localhost:8080
```
