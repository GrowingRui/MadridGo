# Cost Analysis

**Status:** Phase 0, 2026-11-09. Prices marked [U] were not confirmed on the vendor's own pricing page and must be rechecked before purchase. Hetzner changed prices twice in 2026 (1 April and 15 June), per third-party reports.

## 1. Local development — **€0**
| Item | Cost | Notes |
|---|---|---|
| Docker Desktop / Engine | €0 | Docker Desktop is free for personal use and small businesses [U: confirm current Docker subscription terms] |
| PostgreSQL, PostGIS, Redis, OTP, Java 25 | €0 | Open source |
| Expo SDK, React Native, EAS dev builds | €0 | Local builds free; EAS cloud has a free tier [U] |
| Data (CRTM, EMT, Renfe, OSM) | €0 | Open licences; EMT requires free registration |
| Map tiles (OpenFreeMap) | €0 | No key, no limits stated ([openfreemap.org](https://openfreemap.org)) |
| GitHub (repo + Actions) | €0 | Free tier |
| **Hardware note** | – | OTP graph build for Madrid estimated at 4–8 GB heap [I]. A machine with ≥ 16 GB RAM is recommended |

## 2. MVP deployment (private beta)
| Item | Monthly | Notes |
|---|---|---|
| One VPS, 16 GB RAM, 4–8 vCPU (OTP + API + PostGIS + Redis) | **≈ €16–30** [U] | A Sept-2026 comparison listed Hetzner CX43 at €15.99, possibly before the June increase. Estimate up to about €22 after it [U]. Measure OTP RAM first |
| Backups (VPS snapshots / object storage) | ≈ €2–5 [U] | |
| Domain (.es or .app) | ≈ €1/month (€10–20/year) [U] | |
| TLS | €0 | Caddy / Let's Encrypt |
| Monitoring | €0 | Uptime Kuma self-hosted, or a free tier |
| Push notifications | €0 | Expo Push / FCM / APNs have no per-message fee [I] |
| Website hosting | €0 | Static files served by Caddy on the same VPS. Free static hosts (GitHub Pages, Cloudflare Pages) are an alternative [U: confirm their terms] |
| **Total** | **≈ €20–35 / month** | |

## 3. Production deployment (public launch)
| Item | Monthly | Notes |
|---|---|---|
| 2 × application VPS (OTP redundancy; OTP is memory-heavy and restart-slow) | ≈ €35–60 [U] | |
| Managed or dedicated PostgreSQL, or a third VPS | ≈ €15–50 [U] | |
| Map tiles | €0 (OpenFreeMap) or self-hosted PMTiles (≈ €0–5 storage plus CDN) | OpenFreeMap has no SLA; self-hosting removes that dependency |
| Error tracking (Sentry free tier or self-hosted GlitchTip) | €0–26 [U] | |
| **Total** | **≈ €50–140 / month** | Scales mainly with OTP replicas |

## 4. App publication
| Item | Cost | Source |
|---|---|---|
| Apple Developer Program | **99 USD/year** (charged in local currency incl. VAT; the euro amount varies) [V via multiple secondary sources; confirm on developer.apple.com] | |
| Google Play Console | **25 USD one-time** [V via multiple secondary sources] | |
| Mac for iOS builds | €0 if EAS cloud builds are used (free tier quota) [U] | |
| Store commissions | n/a | No in-app purchases planned |

## 5. Real-time data access
| Source | Cost |
|---|---|
| Renfe GTFS-RT | €0, CC BY 4.0 [V alerts] |
| EMT MobilityLabs | €0, terms state free access to public content [V] |
| CRTM real-time | **Unknown**: depends on CRTM's response. No price published [U] |

## 6. Hidden or recurring effort costs (non-monetary, but real)
- Weekly GTFS refresh monitoring (Cercanías feed valid for about one month).
- Station transfer-time curation.
- Legal: a privacy policy and terms of use. Templates can be used, but a professional review (≈ €300–1 000 one-off [U]) is advisable before public launch.

## 7. Summary
| Stage | One-off | Recurring |
|---|---|---|
| Local development | €0 | €0 |
| MVP | ≈ €10–20 (domain) | ≈ €20–35/month |
| Production | – | ≈ €50–140/month |
| Publication | 25 USD (Google) | 99 USD/year (Apple) |
