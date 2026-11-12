// Step-by-step trip guide (SBB's journey steps): a saved trip cut into what you do, one step
// at a time: walk, ride, change, arrive. Each step knows whether it is done, happening now,
// next, or later, from the live times already on the journey (no extra requests).
// The texts are built here with t(), like utils/trainPosition.ts: called while a component
// that uses useT() renders.

import type { Journey, Leg, Transfer } from '../api/journeys';
import type { Line } from '../api/stops';
import { t, tn } from '../i18n';
import { expectedMs } from '../state/connections';
import { type ChangeTone, changeDetails, walkLegsInChanges } from './changeDetails';
import { formatTime, minutesUntil } from './time';

export type StepState = 'done' | 'now' | 'next' | 'later';

export type TripStep =
  | { kind: 'walk'; leg: number; startMs: number; endMs: number; state: StepState }
  | { kind: 'ride'; leg: number; startMs: number; endMs: number; state: StepState }
  | { kind: 'change'; change: number; startMs: number; endMs: number; state: StepState }
  | { kind: 'arrive'; startMs: number; endMs: number; state: StepState };

type Untimed = TripStep extends infer S ? (S extends TripStep ? Omit<S, 'state'> : never) : never;

/** The steps of a journey, in order, each with its state at `now`. */
export function tripSteps(journey: Journey, now: number = Date.now()): TripStep[] {
  const inChanges = walkLegsInChanges(journey);
  const steps: Untimed[] = [];
  journey.legs.forEach((leg, i) => {
    if (leg.mode === 'walk') {
      if (!inChanges.has(i)) {
        steps.push({
          kind: 'walk',
          leg: i,
          startMs: expectedMs(leg.departure),
          endMs: expectedMs(leg.arrival),
        });
      }
      return;
    }
    steps.push({
      kind: 'ride',
      leg: i,
      startMs: expectedMs(leg.departure),
      endMs: expectedMs(leg.arrival),
    });
    const c = journey.changes.findIndex((x) => x.from_leg === i);
    const next = c >= 0 ? journey.legs[journey.changes[c].to_leg] : undefined;
    if (next) {
      steps.push({
        kind: 'change',
        change: c,
        startMs: expectedMs(leg.arrival),
        endMs: Math.max(expectedMs(leg.arrival), expectedMs(next.departure)),
      });
    }
  });
  const end = expectedMs(journey.arrival);
  steps.push({ kind: 'arrive', startMs: end, endMs: end });

  // done: over; now: under way; next: the first one still to come when nothing is under way.
  let nextGiven = false;
  return steps.map((s) => {
    let state: StepState;
    if (now >= s.endMs) state = 'done';
    else if (now >= s.startMs) state = 'now';
    else if (!nextGiven) state = 'next';
    else state = 'later';
    if (state === 'now' || state === 'next') nextGiven = true;
    return { ...s, state } as TripStep;
  });
}

/** The step to show first: the one under way, else the next one, else the last. */
export function focusIndex(steps: TripStep[]): number {
  const i = steps.findIndex((s) => s.state === 'now' || s.state === 'next');
  return i >= 0 ? i : steps.length - 1;
}

/**
 * Stops still to come on a ride, counting the one you get off at. The timetable's stop times
 * are moved by the train's live delay at departure.
 */
export function stopsLeft(leg: Leg, now: number): number {
  const shift = expectedMs(leg.departure) - Date.parse(leg.departure.scheduled);
  return leg.intermediate.filter((s) => Date.parse(s.time) + shift > now).length + 1;
}

/** "Cercanías C-4", "Bus 27". */
export function lineName(line: Line | null | undefined, leg: Leg): string {
  const mode = t(`mode.${leg.mode}`);
  return line ? `${mode} ${line.short_name}` : mode;
}

const metres = (m: number | null | undefined) => (m ? ` · ${Math.round(m / 10) * 10} m` : '');

export interface StepText {
  /** Done / Now / Next / Then. */
  label: string;
  title: string;
  lines: string[];
  tone: ChangeTone;
  /** The line ridden (ride) or the one changed to (change), for its pictogram. */
  line: Line | null;
}

/** What a step says, e.g. "Now" · "C-4 to Atocha" · "Get off at Atocha in 3 stops (17:22)". */
export function stepText(journey: Journey, step: TripStep, now: number): StepText {
  const label = t(`steps.state.${step.state}`);
  const at = (ms: number) => formatTime(ms);
  switch (step.kind) {
    case 'walk': {
      const leg = journey.legs[step.leg];
      return {
        label,
        title: t('journey.walk', {
          min: leg.duration_min,
          distance: metres(leg.distance_m),
          stop: leg.to,
        }),
        lines: [t('steps.fromTo', { from: at(step.startMs), to: at(step.endMs) })],
        tone: 'ok',
        line: null,
      };
    }
    case 'ride': {
      const leg = journey.legs[step.leg];
      const title = t('steps.rideTo', {
        line: lineName(leg.line, leg),
        dir: leg.headsign || leg.to,
      });
      const lines: string[] = [];
      if (leg.departure.status === 'cancelled' || leg.arrival.status === 'cancelled') {
        return { label, title, lines: [t('steps.cancelled')], tone: 'danger', line: leg.line ?? null };
      }
      if (step.state === 'now') {
        const n = stopsLeft(leg, now);
        lines.push(
          n === 1
            ? t('steps.getOffNext', { stop: leg.to, time: at(step.endMs) })
            : tn('steps.getOffIn', n, { stop: leg.to, time: at(step.endMs) }),
        );
      } else if (step.state === 'done') {
        lines.push(t('steps.gotOff', { stop: leg.to, time: at(step.endMs) }));
      } else {
        const min = minutesUntil(new Date(step.startMs).toISOString(), now);
        lines.push(
          step.state === 'next' && min < 60
            ? min <= 0
              ? t('steps.boardNow', { stop: leg.from, time: at(step.startMs) })
              : t('steps.boardIn', { stop: leg.from, time: at(step.startMs), n: min })
            : t('steps.board', { stop: leg.from, time: at(step.startMs) }),
        );
        if (leg.departure.platform) lines.push(t('journey.platform', { p: leg.departure.platform }));
        lines.push(t('steps.getOff', { stop: leg.to, time: at(step.endMs) }));
      }
      return { label, title, lines, tone: 'ok', line: leg.line ?? null };
    }
    case 'change': {
      const change: Transfer = journey.changes[step.change];
      const d = changeDetails(journey, change);
      const next = journey.legs[change.to_leg];
      const to = lineName(next.line, next);
      const lines: string[] = [];
      const head =
        d.changeMin != null && d.changeMin >= 0
          ? t('change.time', { n: d.changeMin })
          : change.wait_up_to_min != null
            ? t('journey.waitUpTo', { n: change.wait_up_to_min })
            : null;
      const walk =
        d.walkLegs.length || d.walkMin > 0
          ? t('steps.walkTo', {
              min: d.walkMin,
              distance: d.walkM ? ` · ${d.walkM} m` : '',
              line: to,
            })
          : d.toPlatform
            ? t('steps.toLinePlatform', { line: to, p: d.toPlatform })
            : t('steps.toLine', { line: to });
      lines.push(head ? `${head} · ${walk}` : walk);
      if (d.walkTo) lines.push(t('steps.walkStop', { stop: d.walkTo }));
      if (
        change.label === 'tight' ||
        change.label === 'at_risk' ||
        change.label === 'not_feasible'
      ) {
        lines.push(t(`change.advice.${change.label}`));
      }
      return {
        label,
        title: t('change.at', { stop: change.at }),
        lines,
        tone: d.tone,
        line: next.line ?? null,
      };
    }
    case 'arrive':
      return {
        label,
        title: t('steps.arrive', { stop: journey.legs[journey.legs.length - 1]?.to ?? '' }),
        lines: [at(step.startMs)],
        tone: 'ok',
        line: null,
      };
  }
}
