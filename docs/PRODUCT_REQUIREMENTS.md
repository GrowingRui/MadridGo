# Product Requirements — MadridGo

**Status:** Phase 0 draft, 2026-11-09. Requirements marked *(data-gated)* depend on data access that is not yet authorized (see REALTIME_DATA_COVERAGE.md).

## 1. Vision
"Reliable journeys. Real-time Madrid."
MadridGo helps people in the Community of Madrid choose and complete public transport journeys using information that is **accurate, labelled with its provenance, and honest about uncertainty**.

Guiding principle: **Reliability first.** A smaller set of trustworthy features beats a larger set built on unverified data.

Benchmark: SBB Mobile (journey planning, travel companion, disruption alerts, commuter routes, interactive station map; https://www.sbb.ch/en/travel-information/apps/sbb-mobile/functions.html). MadridGo has its **own original visual identity**; no SBB branding or assets. Ticketing (a major SBB feature) is **out of scope**.

## 1.1 Platforms
MadridGo is available on **iOS, Android and the web**, as SBB is (app and sbb.ch).
- One Expo / React Native codebase builds the native apps and a static website (react-native-web).
- The website offers the same core features: planner, results, stop boards, map and alerts. Push notifications and background journey monitoring are **mobile-only** at first. Web push is a possible later addition.
- Favorites on the web are stored in the browser (local storage). There is no sync with the phone until accounts exist.

## 2. Target users
| Persona | Need |
|---|---|
| Daily commuter (for example Parla → Atocha by C-4, or interurban bus 469) | Fast "Home → Work" plan; know whether the bus or train is on time; be warned about disruptions |
| Urban rider in Madrid city | Next EMT bus at a stop; Metro alternatives |
| Occasional or visitor rider | Multimodal planning with walking directions; clear transfer instructions |
| Rider with reduced mobility | Step-free information where data exists |

## 3. Functional requirements

### 3.1 Journey planning
- **FR-1** Origin and destination search: stops, stations, addresses and places, plus current location.
- **FR-2** Swap origin and destination.
- **FR-3** Depart-at and arrive-by time selection.
- **FR-4** Several alternatives, rankable by earliest arrival, fewest transfers, and least walking.
- **FR-5** Multimodal legs: Metro, ML, Cercanías, EMT, interurban and urban buses, and walking.
- **FR-6** Each leg shows line, direction, boarding and alighting stop, times, platform when known, and a real-time status badge.
- **FR-7** Each transfer shows walking time, the available margin, and a **reliability label** (see RELIABILITY_STRATEGY.md §5). There is **no invented probability**.

### 3.2 Real-time information
- **FR-10** Stop departure board (CRTM-widget equivalent): stop name, id, location, lines, destination, next arrivals, and a per-row status: **Live / Scheduled / Frequency estimate / Outdated / Unavailable**.
- **FR-11** Show "updated X s ago" and the data source on every real-time view.
- **FR-12** Cercanías: delays, cancellations, vehicle positions, platform where present.
- **FR-13** EMT: live arrival predictions.
- **FR-14** *(data-gated)* Interurban and urban bus live arrivals and vehicle positions.
- **FR-15** *(data-gated)* Metro and ML live information.
- **FR-16** Service alerts on affected lines, stops and journeys.

### 3.3 Map
- **FR-20** MapLibre map showing stops, nearby stations, and routes of a selected line.
- **FR-21** Live vehicles **only** where an authorized feed provides positions (MVP: Cercanías). No simulated positions.

### 3.4 Personalization
- **FR-30** Favorite stops and favorite routes.
- **FR-31** Recent searches.
- **FR-32** Home and Work shortcuts.
- **FR-33** Stored on-device by default. Optional cloud sync is post-MVP and needs an account.

### 3.5 Monitoring and notifications
- **FR-40** Monitor a saved journey: push notification when a leg is delayed or cancelled, or when a transfer becomes **at risk**.
- **FR-41** Commuter route alerts on chosen days and times (SBB "commuter routes" equivalent).
- **FR-42** When a journey is disrupted, offer recalculated alternatives.

### 3.6 Accessibility
- **FR-50** Show `wheelchair_boarding` where the GTFS provides it (present in ML, interurban and urban feeds); show "unknown" otherwise.
- **FR-51** The app meets platform accessibility guidelines: dynamic type, screen readers, contrast.

## 4. Non-functional requirements
| ID | Requirement | Target (initial, to be validated) |
|---|---|---|
| NFR-1 | Never present stale data as current | 0 occurrences in reliability tests |
| NFR-2 | Every real-time value carries source, retrieval time, and source time where available | 100 % of API responses |
| NFR-3 | Stop board API latency (cached) | p95 < 300 ms |
| NFR-4 | Journey plan latency (OTP) | p95 < 3 s for Madrid-region queries |
| NFR-5 | Backend availability (MVP) | 99 % monthly, single-node |
| NFR-6 | Static data freshness | Alarm 7 days before any GTFS calendar expires |
| NFR-7 | Privacy | No account required; GDPR-compliant; location used on-device or per-request, not stored |
| NFR-8 | Secrets | No API keys in the app; all third-party calls go through the backend |
| NFR-9 | Attribution | "Powered by CRTM", "Powered by EMT de Madrid", Renfe (CC BY 4.0), and "© OpenStreetMap contributors" visible in the app |
| NFR-10 | Languages | Spanish and English |

## 5. MVP scope
**In:**
- Static GTFS for all six CRTM feeds (Metro pending a valid feed, see risk R1).
- OTP journey planning with walking and Cercanías GTFS-RT.
- Stop board: EMT live, Cercanías live, all others **Scheduled** with clear labelling.
- Renfe and EMT alerts.
- Map with stops and live Cercanías trains.
- On-device favorites, recents, Home and Work.
- Spanish and English.

**Out of MVP:** interurban and urban real-time *(until CRTM authorizes)*; Metro real-time; push notifications and journey monitoring (Phase 6); accounts and cloud sync; ticketing and payment; prediction-accuracy dashboards (need historical data first).

## 6. Success criteria for MVP
- A user can plan Parla → Atocha and see Cercanías C-4 options with live delay where Renfe provides it.
- A user opening an EMT stop sees live predictions with source and age.
- A user opening stop 8_16825 sees scheduled times clearly labelled as such, and **no fabricated live data**.
- All reliability test scenarios in RELIABILITY_TEST_PLAN.md pass.
