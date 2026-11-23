# Production web server: Caddy (automatic HTTPS) with the rate-limit plugin, serving the
# website built from apps/mobile. Build context: the repository root.
#   docker compose -f infra/docker-compose.prod.yml --env-file .env.production build caddy

# 1. The website (Expo web export). The API address is baked into the bundle and is public.
FROM node:24-slim AS web
WORKDIR /app
COPY apps/mobile/package.json apps/mobile/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/mobile/ ./
ARG EXPO_PUBLIC_API_URL
RUN test -n "$EXPO_PUBLIC_API_URL" && EXPO_PUBLIC_API_URL="$EXPO_PUBLIC_API_URL" npm run build:web

# 2. Caddy with github.com/mholt/caddy-ratelimit (stock Caddy has no rate limiting).
FROM caddy:2.11-builder AS caddy
ARG RATELIMIT_VERSION=v0.1.0
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@${RATELIMIT_VERSION}

FROM caddy:2.11
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/dist /srv/site
