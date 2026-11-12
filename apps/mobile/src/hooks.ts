import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  type PressableStateCallbackType,
  Platform,
  useWindowDimensions,
} from 'react-native';

import { ApiError } from './api/client';
import { t, useLanguage } from './i18n';
import type { Leg } from './api/journeys';
import { type BusPosition, getBusPosition } from './api/buses';
import { type TripPosition, getTripPosition } from './api/trips';
import { busKeepForward, busQuery, canTrackBus } from './utils/busPosition';
import { canTrack, keepForward } from './utils/trainPosition';

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `fn` when `key` changes; ignores responses that arrive after a newer request. */
export function useAsync<T>(fn: (() => Promise<T>) | null, key: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  // A new language asks again: the server's messages come in the app's language.
  const { lang } = useLanguage();
  // Keep the latest fn without re-running the request when only its identity changes.
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    const run = fnRef.current;
    if (!run) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    run()
      .then((d) => {
        if (id === seq.current) setData(d);
      })
      .catch((e: unknown) => {
        if (id === seq.current)
          setError(e instanceof ApiError ? e.message : t('common.unexpected'));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [key, nonce, lang]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Current time, ticking every `ms` (for countdowns). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Width from which the website switches to its desktop layout (top navigation, split views). */
export const WIDE_BREAKPOINT = 960;

/** True for the desktop website layout. Phones and narrow browser windows use the app layout. */
export function useIsWide(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= WIDE_BREAKPOINT;
}

/**
 * Pressable state including the web-only `hovered` flag (react-native-web sets it; the
 * React Native types only declare it when Expo's generated expo-env.d.ts is present).
 */
export type PressState = PressableStateCallbackType & { hovered?: boolean };

/** The user's "reduce motion" setting: animations then jump instead of moving. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((r) => alive && setReduce(r))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * Live position of a leg's train, polled every ~30 s (the server's poll_after_s) while the
 * journey is open and the app is in the foreground; never re-runs the route search. A failed
 * poll keeps the last answer: it hides itself once too old (utils/trainPosition.ts).
 */
export function useTrainPosition(leg: Leg): TripPosition | null {
  const now = useNow(60_000);
  return useTripPosition(leg.trip_id, leg.from_stop_id, canTrack(leg, now));
}

/** Live position of a leg's EMT bus (journey timeline, trip screen), from 45 min before it leaves. */
export function useLegBus(leg: Leg | null | undefined): BusPosition | null {
  const now = useNow(60_000);
  return useBusPosition(leg ?? null, !!leg && canTrackBus(leg, now));
}

/** The same polling for any trip (the trip screen); `track` false stops it. */
export function useTripPosition(
  tripId: string | null | undefined,
  from: string | null | undefined,
  track: boolean,
): TripPosition | null {
  const [pos, setPos] = useState<TripPosition | null>(null);
  useEffect(() => {
    if (!track || !tripId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (s: number) => {
      clearTimeout(timer);
      timer = setTimeout(poll, s * 1000);
    };
    function poll() {
      if (stopped || AppState.currentState !== 'active') return; // resumed when active
      getTripPosition(tripId as string, from)
        .then((p) => {
          if (stopped) return;
          setPos((prev) => keepForward(prev, p, Date.now()));
          schedule(p.poll_after_s || 30);
        })
        .catch(() => {
          if (!stopped) schedule(30);
        });
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') poll();
    });
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      sub.remove();
    };
  }, [track, tripId, from]);
  return track && pos?.trip_id === tripId ? pos : null;
}

/**
 * Live position of an EMT leg's bus, polled every ~20 s (the server's poll_after_s, the EMT
 * cache's reuse time) while `track` and the app is in the foreground. The bus found by one
 * answer is asked for by its id in the next, so it can be followed onto the leg once it has
 * left your boarding stop. A failed poll keeps the last answer: it hides itself once too old.
 */
export function useBusPosition(leg: Leg | null, track: boolean): BusPosition | null {
  // Answers are kept with the leg they belong to, so another leg never shows this bus.
  const [answer, setAnswer] = useState<{ key: string; pos: BusPosition } | null>(null);
  const vehicle = useRef<string | null>(null);
  const key = leg ? `${leg.trip_id}|${leg.from_stop_id}|${leg.departure.scheduled}` : '';
  useEffect(() => {
    vehicle.current = null;
    if (!track || !leg) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (s: number) => {
      clearTimeout(timer);
      timer = setTimeout(poll, s * 1000);
    };
    function poll() {
      if (stopped || AppState.currentState !== 'active') return; // resumed when active
      getBusPosition(busQuery(leg as Leg, vehicle.current))
        .then((p) => {
          if (stopped) return;
          if (p.vehicle_id) vehicle.current = p.vehicle_id;
          setAnswer((prev) => ({
            key,
            pos: busKeepForward(prev?.key === key ? prev.pos : null, p, Date.now()),
          }));
          schedule(p.poll_after_s || 20);
        })
        .catch(() => {
          if (!stopped) schedule(20);
        });
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') poll();
    });
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      sub.remove();
    };
    // The leg object is replaced at every refresh of a saved trip; `key` is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, key]);
  return track && answer?.key === key ? answer.pos : null;
}
