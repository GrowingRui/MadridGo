# Deployment (Phase 7)

How MadridGo runs on a server. The stack is `infra/docker-compose.prod.yml`; the hosting
provider and domain are not chosen yet, so this guide works for any Linux VPS with Docker.

```
Internet ──443/80──> caddy ──> /srv/site            (website, built into the Caddy image)
                          └──> api:8000 ──> db (PostGIS), redis, otp:8080
                     realtime (worker: Renfe, EMT, alerts, accuracy sampling) ──> db, redis
                     backup (nightly pg_dump) ──> volume "backups"
```

Only Caddy publishes ports. The API, database, Redis and OTP are reachable on the internal
Docker network only.

## What is in place

| Concern | How |
|---|---|
| HTTPS | Caddy gets and renews Let's Encrypt certificates for `$MADRIDGO_DOMAIN` and `api.$MADRIDGO_DOMAIN`; HTTP redirects to HTTPS; HSTS one year. |
| Security headers | Website: CSP (allows only MapLibre from unpkg with SRI, OpenFreeMap, the API), `nosniff`, `Referrer-Policy`, `Permissions-Policy` (location for the site itself only), no framing. API: `default-src 'none'`, `no-referrer`. |
| Rate limiting | Per client address in Caddy (`caddy-ratelimit` plugin): searches 40/min, `/journeys` 30/min, everything 300/min; over the limit: `429` with `Retry-After`. `/trains/live` answers are reused for 5 s. |
| CORS | Only `https://$MADRIDGO_DOMAIN` (the website); only the `Accept-Language` header. The apps are not browsers and do not need CORS. |
| API surface | `MADRIDGO_ENVIRONMENT=production`: no `/docs`, `/redoc`, `/openapi.json`; `/health` without component versions. |
| Logs, no personal data | API: method, path, status, time (no query, no address). Caddy: no query string, IP cut to /16 (IPv4) or /32 (IPv6), no headers, no port; files roll at 10 MB and are deleted after 14 days. Container logs: 3 × 10 MB per service. |
| Backups | `backup` service: `pg_dump` every night at 03:30 Madrid time, newest 7 kept. **Copy them off the server too** (below). |
| Restarts | Every service `restart: unless-stopped`; the API has a health check. |

Tried on 2026-11-23 on the development PC with `MADRIDGO_DOMAIN=localhost` (Caddy's local CA,
ports 8088/8443): headers, `/docs` 404, CORS (own origin allowed, others not), the 429 after 40
searches, log lines without query or full IP, a dump restored into a scratch database with the
same counts, and the website in Chrome (map, Live trains, stop search) without a single CSP
violation.

## Server

- Linux VPS in the EU (GDPR; the privacy policy names the location), Docker Engine with the
  compose plugin.
- **16 GB RAM** recommended: building the OTP graph needs a 5 GB Java heap while OTP (3 GB),
  PostgreSQL and the API keep running. 8 GB only works if the graph is built elsewhere.
- 4 vCPU, 60 GB disk (database ~1.5 GB, OTP inputs and graph ~2 GB, dumps ~70 MB each, images).
- Firewall: allow 22/tcp, 80/tcp, 443/tcp and 443/udp; nothing else.
- SSH with keys only; automatic security updates (`unattended-upgrades`).

## First deployment

1. DNS: `A` (and `AAAA` if the server has IPv6) records for `$MADRIDGO_DOMAIN` and
   `api.$MADRIDGO_DOMAIN` pointing at the server.
2. On the server: `git clone` the repository, then `cp .env.production.example .env.production`
   and fill it in (`POSTGRES_PASSWORD` from `openssl rand -base64 32`, EMT keys, domain, email).
3. Data. The simplest is to bring the development database and OTP graph:
   - on the PC: `docker compose -f infra/docker-compose.yml --env-file .env exec db pg_dump -U madridgo -Fc -Z6 madridgo > madridgo.dump`
     and copy `madridgo.dump` and the folder `data/otp/` to the server (`data/otp/` next to `infra/`);
   - on the server: `docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d db`,
     then `docker compose ... exec -T db pg_restore -U madridgo -d madridgo --no-owner < madridgo.dump`.
4. Start everything: `docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d --build`
   (the Caddy image builds the website with `EXPO_PUBLIC_API_URL=https://api.$MADRIDGO_DOMAIN`;
   about 3 minutes).
5. Check (from your own computer):
   - `curl -sI https://$MADRIDGO_DOMAIN` shows `Strict-Transport-Security` and `Content-Security-Policy`;
   - `curl https://api.$MADRIDGO_DOMAIN/health` gives `"status":"ok"` and `/docs` gives 404;
   - the website opens, the map draws, a journey plans;
   - `docker compose ... exec caddy tail -3 /var/log/caddy/api.log`: `remote_ip` must look like
     *your* address cut to /16 (e.g. `83.45.0.0`). If every line shows the same Docker address
     (`172.x.0.0`), Docker is hiding client addresses (its userland proxy, usually for IPv6) and the
     rate limit would count all users together: set `"userland-proxy": false` (and
     `"ip6tables": true`) in `/etc/docker/daemon.json` and restart Docker.

## Updates

`git pull`, then `docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d --build`.
The database volume, certificates, logs and backups survive. A new database migration runs when
the realtime worker starts (as in development).

**Timetable refresh is not on the server yet** (the Windows task does it on the development PC).
Next step of Phase 7: a Linux version of `scripts/refresh-feeds.ps1` run weekly by cron on the
server. Until then, Renfe's feed (about four weeks at a time; currently to 2026-12-22) must be
refreshed by hand.

## Backups

- Dumps are in the `backups` volume (`docker compose ... exec backup ls -lh /backups`). Run one
  now with `docker compose ... exec backup /bin/sh /backup.sh --once`.
- **Off the server:** a dump only on the same disk does not survive losing the server. Copy the
  newest dump daily to other storage (the provider's backup space or object storage), e.g. a cron
  job at 04:30 with `rclone copy` or `rsync`. To be set up with the hosting choice.
- Restore: `docker compose ... exec -T db pg_restore -U madridgo -d madridgo --clean --if-exists --no-owner < madridgo-YYYY-MM-DD.dump`,
  then restart `api` and `realtime`.
- What matters most: the accuracy and punctuality data (`prediction_sample`, `observed_arrival`,
  `accuracy_daily`, `usual_delay`) cannot be recreated; timetables can be re-imported.

## Monitoring

- An external uptime monitor (e.g. a free UptimeRobot or Better Stack check) every 5 minutes on
  `https://api.$MADRIDGO_DOMAIN/health`, alerting when the status is not 200 or the body lacks
  `"status":"ok"`, and one on the website. It sees the same answer as users, not Caddy's.
- `/feeds` shows each timetable's expiry; `python -m app.ingest status` (exit 2 when a feed is
  expiring) will be part of the server's refresh job.

## Trying it on a PC

Use a `.env` file with `MADRIDGO_DOMAIN=localhost`, `MADRIDGO_SITE_ORIGIN=https://localhost:8443`,
`MADRIDGO_API_ORIGIN=https://api.localhost:8443`, `HTTP_PORT=8088`, `HTTPS_PORT=8443`, any
`ACME_EMAIL`, and the `POSTGRES_*` values of the development `.env`. Stop the development stack
first (`docker compose -f infra/docker-compose.yml --env-file .env --profile otp down`): both use
the project name `madridgo`, so the production stack reuses the same database volume. Open
`https://localhost:8443` (the browser warns about Caddy's local certificate).
