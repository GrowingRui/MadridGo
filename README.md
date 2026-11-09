# MadridGo

Reliable journeys. Real-time Madrid.

MadridGo is a multimodal public transport app and website for the Community of Madrid. Reliability comes first: every time it shows is labelled as live, scheduled or unavailable, together with its source and age.

- Research, architecture and roadmap: [docs/](docs/)
- Current phase: **Phase 1, Architecture and foundation** (see [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md))

## Repository layout

```
apps/mobile/       Expo + React Native + TypeScript app (iOS, Android and web)
services/api/      FastAPI backend (Python 3.12)
infra/             Docker Compose for local development
docs/              Phase 0 research and design documents
```

## Prerequisites
- Docker Desktop
- Python 3.12+
- Node.js 24+ and npm

## Run the backend (Docker)

```bash
cp .env.example .env        # then set POSTGRES_PASSWORD (and the matching password in MADRIDGO_DATABASE_URL)
docker compose -f infra/docker-compose.yml --env-file .env up -d --build
curl http://localhost:8000/health
```

`/health` returns `200` with `"status": "ok"` when PostGIS and Redis are reachable. It returns `503` with per-dependency details when they are not. The OpenAPI docs are at http://localhost:8000/docs.

Stop the stack with `docker compose -f infra/docker-compose.yml down`. Add `-v` to also delete the database volume.

## Backend development

```bash
cd services/api
python -m venv .venv
.venv/Scripts/activate          # Windows (Git Bash: source .venv/Scripts/activate); macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
ruff check . && ruff format --check . && mypy && pytest
```

Integration tests need the Docker stack running. Load `.env` into your shell first:

```bash
MADRIDGO_INTEGRATION=1 pytest
```

## Mobile app

```bash
cd apps/mobile
npm install
echo "EXPO_PUBLIC_API_URL=http://<your-computer-LAN-IP>:8000" > .env
npx expo start
```

- **Physical phone (Expo Go):** use your computer's LAN IP, for example `http://192.168.1.50:8000`. The phone and computer must be on the same Wi-Fi network, and Windows Firewall must allow port 8000.
- **Android emulator:** use `http://10.0.2.2:8000`.
- `EXPO_PUBLIC_*` values are bundled into the app and are **public**. Never put API keys there. All provider credentials stay in the backend.
- Phase 5 adds MapLibre, which needs an Expo **development build** instead of Expo Go.

Checks: `npm run typecheck && npm run lint && npm test`

### Website
The same app runs in the browser:

```bash
cd apps/mobile
npx expo start --web          # dev server at http://localhost:8081 (allowed by the API's CORS)
npm run build:web             # static site in apps/mobile/dist/
```

For the web, `EXPO_PUBLIC_API_URL=http://localhost:8000` works. To use another domain, add it to `MADRIDGO_CORS_ORIGINS`.

## Data and attribution
Planned data sources and their licences are listed in [docs/DATA_SOURCE_ANALYSIS.md](docs/DATA_SOURCE_ANALYSIS.md). The required attributions are:
- Powered by CRTM
- Powered by EMT de Madrid
- Renfe (CC BY 4.0)
- © OpenStreetMap contributors
