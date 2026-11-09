# MadridGo

Reliable journeys. Real-time Madrid.

MadridGo is a multimodal public transport app and website for the Community of Madrid. Reliability comes first: every time it shows is labelled as live, scheduled or unavailable, together with its source and age.

- Research, architecture and roadmap: [docs/](docs/)
- Current phase: **Phase 2, Static data** (see [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md))
- UI design: [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)

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

## Static timetable data (Phase 2)

The pipeline downloads the six CRTM GTFS feeds, validates them with the MobilityData validator (Docker), and imports them into PostGIS as versioned feeds. A new version is switched on only after it imports completely, and the previous one is kept for rollback. Downloads go to `data/`, which git ignores.

Run these from `services/api` with the venv active. Load the root `.env` into your shell first (Git Bash: `set -a; source ../../.env; set +a`).

```bash
python -m app.ingest update                 # all feeds: download, validate, import, activate (~3 min)
python -m app.ingest update -s cercanias    # a single feed; unchanged feeds are skipped (--force to re-import)
python -m app.ingest status                 # active versions and expiry; exit code 2 if a feed has expired
python -m app.ingest validate               # validate the active versions again
```

The API then serves:
- `GET /stops/search?q=atocha`: accent-insensitive, typo-tolerant search by name or stop code
- `GET /stops/nearby?lat=40.4168&lon=-3.7038`
- `GET /stops/{id}` and `GET /stops/{id}/departures`: scheduled departures. Metro and EMT publish only frequencies, so their lines are returned as "every ~N min", never as invented times.
- `GET /feeds`: which timetable versions are active and when they expire

Rebuild the API image after pulling (`docker compose ... up -d --build`) so the container has the new endpoints.

### Journey planner engine (OpenTripPlanner)

```bash
python -m app.ingest otp-prepare            # copies active feeds + Madrid OSM extract to data/otp/
docker compose -f infra/docker-compose.yml --env-file .env --profile otp-build run --rm otp-build   # ~5 min, 5 GB heap
docker compose -f infra/docker-compose.yml --env-file .env --profile otp up -d otp                  # http://127.0.0.1:8080
```

The graph is about 280 MB. Serving it uses about 1.8 GB of RAM. The heap sizes can be changed with `OTP_BUILD_HEAP` and `OTP_HEAP` in `.env`.

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

Screens: Plan, Departures (real scheduled stop boards), Saved and More (data status). Journey results use labelled **preview data** until the Phase 4 journeys API. On desktop browsers the website switches to its own layout (top navigation, planner in one row, connections and journey side by side). See [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md).

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
