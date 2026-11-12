# Technical, Data and Legal Risks

**Status:** Phase 0, 2026-11-09. Likelihood and impact use H/M/L ratings.

| ID | Risk | L | I | Evidence | Mitigation |
|---|---|---|---|---|---|
| **R1** | **Metro GTFS expired** (calendar ended 2026-05-27); without it, Metro routing returns nothing | H (already true) | H | Downloaded CRTM item `5c7f…246`, feed_version 20250527 | Ask CRTM; check NAP and Mobility Database mirrors for a newer feed; block expired feeds; any calendar extension only with explicit product approval and a visible "frequency estimate, outdated source" label |
| **R2** | **No authorized real-time source for interurban/urban buses**, including the owner's stop 8_16825 | H | H | CRTM licence covers static data only; widget API undocumented | Formal CRTM request; adapter ready but disabled; MVP shows Scheduled with honest labels |
| R3 | Using the widget API without permission leads to blocking or legal exposure | M if used | H | Licence lets CRTM block abusive reusers | **Do not use** it in development pipelines or production |
| R4 | CRTM real-time (even if authorized) lacks prediction/schedule flag and observation timestamp | M | H | Widget response fields (CRTM_WIDGET_ANALYSIS.md §5.3) | Request GTFS-RT instead; if only the widget is offered, require documentation of semantics |
| R5 | No Metro / Metro Ligero real-time | H | M | No public source found | Frequency-based display; revisit when CRTM responds |
| R6 | EMT and Metro GTFS are headway-based, so "scheduled time" is only an estimate and delays cannot be computed | H | M | `frequencies.txt` without `exact_times` | UI shows "every N min"; EMT shows predictions only |
| R7 | EMT API semantics and quotas unknown | M | M | Terms list no numeric limits | Verify with a key in Phase 3; shared cache; request coalescing |
| R8 | Renfe RT trip_id ↔ Cercanías static trip_id mismatch | M | H | Verified: 100 % match (Phase 2 with CRTM's copy; 2026-11-12 with Renfe's own feed) | Static Cercanías now comes from Renfe's own GTFS, the same source as the RT feed |
| R9 | Renfe TripUpdates mostly carry a single stop update, so downstream times are propagated estimates | H | M | Observed 73 of 81 Madrid TUs with one STU | Label "estimated from current delay"; measure accuracy |
| R10 | Interurban GTFS marked "Datos parciales" | M | M | Dataset description | Track missing lines; show "timetable may be incomplete" where known |
| R11 | Short Cercanías GTFS validity (about 1 month) | H | M | CRTM's copy lagged (still ended 2026-11-28 on 2026-11-12); Renfe's own feed ran to 2026-12-11 | Read Renfe's feed directly (since 2026-11-12); weekly automated refresh plus expiry alarm (warns 7 days ahead) |
| R12 | OTP memory and CPU higher than budgeted | M | M | OTP docs: < 1 GB to > 100 GB | Measure in Phase 2; restrict OSM extract to the Community of Madrid |
| R13 | OpenFreeMap has no SLA | M | L | Free community service | Self-host PMTiles before public launch |
| R14 | Upstream licence or terms change (CRTM, EMT may modify at any time) | M | M | Both terms allow unilateral modification | Quarterly licence review; attribution centralised; source flag allows quick disable |
| R15 | GDPR: location and push tokens are personal data | M | M | – | No accounts in MVP; on-device favorites; minimal device table; privacy policy; DPIA-lite before Phase 6 |
| R16 | Public expectation of "SBB-level" reliability that Madrid data cannot support (e.g. no Metro live) | H | M | This analysis | Honest coverage screen in-app; never claim full coverage |
| R17 | Single developer and long roadmap | H | M | – | Strict MVP; phase exit criteria |
| R18 | API keys leaked in the mobile bundle | L | H | – | All third-party calls go through the backend; secret scanning in CI |
| R19 | DST and service-day bugs produce wrong times | M | H | Common in GTFS systems | Property tests (RELIABILITY_TEST_PLAN.md R14) |
| R20 | CRTM widget API returns surprising data (e.g. `5_122` returned Metro times) | – | – | Observed | Another reason it is not a dependable source without documentation |

## Unresolved questions (need external answers)
1. Will CRTM grant access to the real-time feed it provides to Google Maps? Under what licence?
2. Will CRTM publish a current Metro GTFS?
3. EMT API: quotas, observation timestamps, estimate flags, vehicle positions?
4. Renfe TripUpdates/VehiclePositions licence (assumed CC BY 4.0 like alerts)?
5. Real OTP memory footprint for the Madrid graph.
