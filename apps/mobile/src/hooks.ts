import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  type PressableStateCallbackType,
  Platform,
  useWindowDimensions,
} from 'react-native';

import { ApiError } from './api/client';
import type { Leg } from './api/journeys';
import { type TripPosition, getTripPosition } from './api/trips';
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
        if (id === seq.current) setError(e instanceof ApiError ? e.message : 'Unexpected error');
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [key, nonce]);

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
