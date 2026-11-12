// What to say at a change (SBB-style "change time" box): the time between getting off and
// the next departure, the platforms, the walk in between, and how worried to be. The label
// and the spare minutes come from the backend (services/api/app/transfers.py); this only
// gathers what the journey's legs already say.

import type { Journey, LegTime, Transfer, TransferLabel } from '../api/journeys';

/** ok: nothing to say; warning: tight or uncertain; danger: at risk or not possible. */
export type ChangeTone = 'ok' | 'warning' | 'danger';

export interface ChangeDetails {
  /** Minutes from getting off to the next departure; null onto a frequent service. */
  changeMin: number | null;
  walkMin: number;
  /** Metres walked, when the walk legs say (rounded to 10 m); null when unknown or no walk. */
  walkM: number | null;
  /** Where the walk ends, when it is a different stop from where you get off. */
  walkTo: string | null;
  fromPlatform: string | null;
  toPlatform: string | null;
  /** Indexes of the walk legs that belong to this change (shown inside the change box). */
  walkLegs: number[];
  tone: ChangeTone;
}

/** The best estimate of a time: live when there is one, else the timetable. */
export function bestTime(t: LegTime): string {
  return t.status === 'live' && t.estimated ? t.estimated : t.scheduled;
}

const TONE: Record<TransferLabel, ChangeTone> = {
  comfortable: 'ok',
  tight: 'warning',
  uncertain: 'warning',
  at_risk: 'danger',
  not_feasible: 'danger',
};

export function changeTone(label: TransferLabel | null): ChangeTone {
  return label ? TONE[label] : 'ok';
}

export function changeDetails(journey: Journey, change: Transfer): ChangeDetails {
  const off = journey.legs[change.from_leg];
  const on = journey.legs[change.to_leg];
  const walkLegs: number[] = [];
  let metres = 0;
  let metresKnown = true;
  for (let i = change.from_leg + 1; i < change.to_leg; i++) {
    const leg = journey.legs[i];
    if (leg?.mode !== 'walk') continue;
    walkLegs.push(i);
    if (leg.distance_m) metres += leg.distance_m;
    else metresKnown = false;
  }
  const frequent = change.label == null && change.wait_up_to_min != null;
  const changeMin =
    off && on && !frequent
      ? Math.round(
          (Date.parse(bestTime(on.departure)) - Date.parse(bestTime(off.arrival))) / 60_000,
        )
      : null;
  const lastWalk = walkLegs.length ? journey.legs[walkLegs[walkLegs.length - 1]] : null;
  return {
    changeMin,
    walkMin: change.walk_min,
    walkM: walkLegs.length && metresKnown && metres > 0 ? Math.round(metres / 10) * 10 : null,
    walkTo: lastWalk && lastWalk.to !== change.at ? lastWalk.to : null,
    fromPlatform: off?.arrival.platform || null,
    toPlatform: on?.departure.platform || null,
    walkLegs,
    tone: changeTone(change.label),
  };
}

/** The walk legs shown inside change boxes, so the timeline does not show them twice. */
export function walkLegsInChanges(journey: Journey): Set<number> {
  const inside = new Set<number>();
  for (const c of journey.changes)
    for (const i of changeDetails(journey, c).walkLegs) inside.add(i);
  return inside;
}
