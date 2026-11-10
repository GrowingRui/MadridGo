# MadridGo Design System

**Status:** second version, 2026-11-09 (closer SBB-style layouts; separate website layout). Code: `apps/mobile/src/theme`, `apps/mobile/src/components`.

## 1. Direction
MadridGo follows the clarity of the Swiss SBB Mobile app and the sbb.ch website: one coloured header holding the From/To card, connections listed right under it, white cards on a light grey background, large tabular times, line pictograms and a "pearl chain" journey line. Only the information architecture is borrowed. Colours, typography, icons and naming are MadridGo's own; no SBB marks, red, fonts or pictograms are used.

The one rule that is MadridGo's own: **every time is shown next to a reliability label.**

| Label | Meaning | Style |
|---|---|---|
| **Live** (green dot) | From an operator real-time feed (Renfe now; EMT in Phase 3) | Green on light green |
| **Scheduled** | Official static timetable | Grey on light grey |
| **Every ~N min** | The operator publishes only a frequency (Metro, EMT); no exact times exist | Amber-brown on light amber |
| **+4′** (red) | Delay, only on live times | Red text next to the scheduled time |

Colour is never the only signal: every label also has text.

## 2. Tokens
| Token | Value | Use |
|---|---|---|
| `brand` | `#0B3A82` | Header band, primary buttons, links (logo navy) |
| `accent` | `#FFB31A` | Main call to action on the navy header, saved star. Never text on white |
| `bg` / `surface` | `#F3F4F6` / `#FFFFFF` | Page / cards |
| `text` / `textMuted` | `#16181D` / `#5B6270` | Body / secondary |
| `live`, `delay`, `warning` | `#0E7C3A`, `#C4161C`, `#8A5300` | Reliability states |

### Dark mode
More → Appearance: Light (default) or Dark; stored on the device. The dark palette (`theme/index.ts`) uses dark grey surfaces (`bg` `#0F1217`, `surface` `#191D24`), light text (`#E9ECF1`), a lighter blue for links, icons and selected states (`brand` `#8CB2F2`) and lighter reliability colours on dark backgrounds. Navy bars (header, Plan view switch, touch tiles) use `header` / `headerDark`; filled buttons use `primary` / `onPrimary`. Line colours from GTFS never change; very dark lines (C4 navy) get a faint outline on dark cards. The map uses the OpenFreeMap "dark" style. Every text and label pair keeps at least 4.5:1 contrast in both schemes (`theme/theme.test.ts`).

Style sheets are written as `themed(() => StyleSheet.create({ ... }))` and colours are read from `colors` at render time, so a new scheme re-mounts the screens (the navigation state is kept) and every style is read again.

- Spacing: 4 / 8 / 12 / 16 / 24 / 32. Radius: 6 (pictograms), 10 (inputs, buttons), 14 (cards).
- Type: the system font. Times use tabular figures (22 / 18 / 16 pt bold); headings 24 / 17 pt bold; labels 12 pt upper case.
- Width: content is capped at 760 px and centred; the planner and split views use up to 1200 px.

### App and website
One codebase, two layouts with the same colours and components. The switch is `useIsWide()` (web and at least 960 px wide).

| | App (phones, narrow windows) | Website (desktop) |
|---|---|---|
| Navigation | Bottom tab bar | White top bar: logo, Plan a journey · Departures · Saved · Data status; active link underlined in navy |
| Planner | From/To stacked in the navy header; typing happens in place, suggestions below | From ⇄ To in one row in a full-width navy band; suggestions in a dropdown under the field |
| Connections | List under the planner; tapping opens the journey page | Split view: list on the left, the selected journey's timeline on the right |
| Header | Fixed | Scrolls with the page |
| Footer | None | Attributions and independence note |

## 3. Components
- **LinePill**: line name on the route's official GTFS colour (`route_color` / `route_text_color`). Metro lines are round, as on Madrid signage; other modes use a rounded box. A per-mode fallback is used when a feed has no colour.
- **StatusBadge**: the reliability label above.
- **PlannerCard**: From/To with a rail-style dot connector and a swap button; `layout="row"` puts both fields in one row (website).
- **WhenBar** (inside the PlannerCard, under From/To, as on Swiss timetables): `Mon 09.11. | 21:29 Dep | ⟲` on the left, an options button on the right. Date or time opens the **TimeSheet**: Departure/Arrival, the next 7 days, hour and minutes (5-minute steps), Now and Done; always Madrid time. ⟲ goes back to now. The options button opens the **OptionsSheet** (sort: earliest arrival, shortest travel time, fewest changes, least walking) and shows an amber dot when it is not the default. Sheets are bottom sheets in the app and centred dialogs on the website.
- **ConnectionCard**: a timetable row. Line pictograms, "Direction …" and the countdown ("in 6 min"); departure time, pearl chain, arrival time; platform and reliability label on the left, duration and changes on the right. A selected row (website) has a navy left edge.
- **PearlChain**: one line per journey with a segment per leg sized by its duration and coloured by its line; black pearls at start and end, white pearls at changes, dotted grey for walking. On the navy header it sits on a white strip.
- **JourneyTimeline**: Time | track | stop and ride | Platform columns, with expandable intermediate stops and a change note after each vehicle you leave (TransferBadge and the reason, or "Wait up to N min" onto a frequent service).
- **TransferBadge**: Comfortable (green), Tight (amber), At risk and Not possible (red), Uncertain (grey). Words only, never a percentage. A ConnectionCard shows it only when the worst change is not Comfortable; a journey that is not possible shows its first issue in red instead.
- **Times**: a live time is printed as the scheduled time with the delay in red ("20:44 +6′"). For headway services (EMT) there is no timetable to compare with, so the live time itself is printed with no delay. Cancelled times are struck through.
- **DepartureRow / FrequencyRow**: time | line | destination and label | countdown ("6 min") on the right. Frequency rows show "~7′" and "until 00:30" instead of a time.
- **TopNav / Footer**: website only.
- On the navy header, line pictograms get a thin white outline so dark lines (C4) stay visible.
- **Notice**: info (blue), warning (amber) and danger (red) banners, for example "Metro timetable expired".

## 4. Screens
| Tab / route | Content | Data |
|---|---|---|
| Plan (`/`) | Header with From/To and time chips. Before a search: saved and recent stops. Once both are set: timetable notices (for example "Metro timetable expired"), operators whose live data is down, then connections with Earlier/Later under the planner (website: list and journey side by side) | `/journeys` |
| From/To search (in place on Plan) | Tapping From or To turns the field into a text box. App: saved, recent and matching stops are listed under the header; after choosing From, To opens by itself; ✕ closes. Website: the same list drops down under the field (Esc closes) | `/stops/search` |
| Stop picker (`/pick`) | Departures tab only: search a stop to open its board | `/stops/search` |
| Journey (`/journey/[id]`) | "Connection" bar with a card overlapping it (From → To, "Today, 1 h 29 min", times around the line with travelled part and now dot), round ☆ save and route-map buttons, "Not possible" banner and service alerts, then a vertical timeline: times, platforms, expandable intermediate stops, walking and each change with its label and reason | The tapped `/journeys` result |
| Departures (`/departures`, `/stop/[id]`) | Stop board: frequent lines, then next departures; data notices; save and plan-from-here | `/stops/{id}/departures` (real) |
| Saved | Favourite stops, stored on the device only | AsyncStorage |
| Route map (`/route-map`) | One connection on the map: legs in line colours along their shapes, walks dashed, stops; a stop opens its board | `/journeys` leg `geometry` |
| More | Settings: language, appearance (light, the default, or dark), location access (allowed or not, with Open settings in the app), starred and recent stops on this device (clear recents, delete both). Then timetable status per operator (expiry), server status, attributions | `/feeds`, `/health`, AsyncStorage |

## 5. Accessibility
- All tappable elements have a role and label. Line pictograms read as "Cercanías C4".
- Times are announced together with their status ("scheduled 17:54", "about every 7 minutes").
- Minimum tap target is 40 px. Text contrast meets WCAG AA; amber is used only as a background or on navy.

## 6. Next
- Phase 5: live train map, a usability test with five users. (Map tab, ES/EN i18n and dark mode are done.)
