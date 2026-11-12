# Real-Time Data Coverage by Operator

**Status:** Phase 0 research. Date: **2026-11-09**.
Legend: **[V]** verified, **[I]** inference, **[U]** unresolved. Sources and evidence: DATA_SOURCE_ANALYSIS.md, CRTM_WIDGET_ANALYSIS.md.

## 1. Capability matrix (what MadridGo may use **today**, legally)

| Capability | Metro | Metro Ligero | Cercanías | EMT | Interurban buses | Municipal urban buses |
|---|---|---|---|---|---|---|
| Static schedule | ⚠️ GTFS **expired** 2026-05-27; headway-based | ✅ GTFS | ✅ GTFS (1-month validity) | ✅ GTFS, headway-based | ✅ GTFS ("partial") | ✅ GTFS |
| Exact scheduled times | ❌ (frequencies only) | ✅ | ✅ | ❌ (frequencies only) | ✅ | ✅ |
| Real-time arrival predictions | ❌ no authorized source | ❌ no authorized source | ✅ GTFS-RT TripUpdates | ✅ MobilityLabs API | 🔒 exists, not authorized | 🔒 exists, not authorized |
| Delay vs schedule | ❌ | ❌ | ✅ (`delay` field) | [U] | 🔒 | 🔒 |
| Vehicle positions | ❌ | ❌ | ✅ GTFS-RT VehiclePositions (includes platform in label) | [U] to verify in API | 🔒 | 🔒 |
| Cancellations | ❌ | ❌ | ✅ (`CANCELED` trips observed) | [U] | 🔒 | 🔒 |
| Service alerts | CRTM website notices only [I] | same | ✅ GTFS-RT Alerts (20 s refresh) | ✅ RSS | CRTM website notices only | same |
| Observation timestamp | – | – | ✅ feed header plus vehicle timestamp | [U] | 🔒 (widget lacks it) | 🔒 |
| Licence | – | – | CC BY 4.0 [V for alerts; U for TU/VP] | EMT terms / ODbL | – | – |

Legend: ✅ available and authorized · ⚠️ available with a serious defect · ❌ no source found · 🔒 data exists but no authorized access path · [U] to be verified.

## 2. Per-operator notes

### Metro de Madrid
- Real-time exists internally (CITRAM, MuévetexMadrid pilot, CRTM widget), but **no public feed**. [V]
- MadridGo MVP: show headway estimates ("every ~5 min") clearly labelled **Scheduled frequency**; never show minute countdowns as live. Once the static GTFS is current again, use it; until then Metro routing is **blocked** (see TECHNICAL_RISKS.md R1).

### Metro Ligero
- Static GTFS valid; no real-time source. Show scheduled times, labelled **Scheduled**.

### Cercanías Madrid (Renfe)
- Best real-time coverage in the region: trip delays, cancellations, vehicle positions, alerts, about 20 s update cadence, no authentication. [V]
- Delay is mostly provided at trip level (one stop update). Downstream times are propagated estimates; label them as "estimated from current delay" [I].

### EMT Madrid
- Authorized real-time arrival API after registration. [V]
- Field-level semantics (prediction vs schedule flag, timestamps, vehicle positions, quota) **must be verified with a key** in Phase 3. [U] Verified 2026-11-12 after EMT approved the application: no prediction-vs-schedule flag and no observation timestamp (ages are measured from retrieval); each arrival has the bus's GPS point; quota 250,000 calls a day. See DATA_SOURCE_ANALYSIS.md §3.
- The static GTFS is headway-based, so a delay ("+3 min") cannot be computed against an exact schedule. Show **predicted minutes** only, not delay. [I]

### Interurban and municipal urban buses (CRTM)
- Real-time exists for urban and interurban buses (Google Maps since 17-04-2026) [V], but the **only accessible interface is the undocumented widget API**, which no licence covers. [V]
- MadridGo MVP: scheduled times from GTFS, labelled **Scheduled — real-time not available for this line in MadridGo**. Activate real-time only after written CRTM authorization.
- **This includes the project owner's reference stop 8_16825.**

## 3. Coverage of the CRTM-widget-equivalent stop screen (spec §3.2)

| Field required by the spec | EMT stop | Cercanías station | Interurban stop (e.g. 8_16825) today |
|---|---|---|---|
| Stop name, id, location | ✅ | ✅ | ✅ (GTFS) |
| Lines, direction/destination | ✅ | ✅ | ✅ (GTFS) |
| Estimated arrivals | ✅ | ✅ | ❌ until CRTM authorizes |
| Scheduled arrivals fallback | ⚠️ headway only | ✅ | ✅ |
| Delay | [U] | ✅ | ❌ |
| Vehicle position | [U] | ✅ | ❌ |
| Last successful update | ✅ (retrieval time; source time [U]) | ✅ | n/a |
| Data source and real-time status | ✅ | ✅ | ✅ ("Scheduled only") |

## 4. Change triggers
Update this document when any of these happen:
- CRTM replies to the access request.
- A valid Metro GTFS is published.
- EMT API fields are verified with a key.
- Renfe TU/VP licence is confirmed.
