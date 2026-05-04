# UI Reference Dashboard (React + Vite)

Standalone reference UI to visualize backend status. It is decoupled from the Python backend and talks to it over HTTP only.

## Run (development)

From `ui-reference/`:

```bash
npm install
npm run dev
```

Open [http://localhost:8080](http://localhost:8080) (Vite is configured to use port `8080` to match existing CORS).

The backend API defaults to `http://localhost:8007`. Override if needed:

```bash
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

## Production build

```bash
npm run build
```

Static files are emitted to `ui-reference/dist/`. Serve with any static host, for example:

```bash
npx serve dist -p 8080
```

Set `VITE_API_BASE_URL` at **build time** if the API is not on the default URL.

## Data / endpoints

Same as before: `GET /feeds`, `GET /channels`, `POST /channels/register`, `GET /channels/{id}/runs`, `GET /channels/{id}/schedule/active`, `POST /channels/{id}/schedule/generate`, `GET /channels/{id}/schedule/active/download`.

## Stack

- React 18
- Vite 6

Legacy static `app.js` / `styles.css` were removed; the app lives under `src/`.
