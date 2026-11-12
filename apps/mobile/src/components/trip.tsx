// The whole route of a journey leg's vehicle, from its origin to its terminus (like SBB's trip
// view): your section is drawn in the line colour, the rest faded, and the point of a
// Cercanías train (utils/trainPosition.ts) or an EMT bus (utils/busPosition.ts) moves along
// the line, with the same rules as on the journey.

import { useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import type { BusPosition } from '../api/buses';
import type { Leg } from '../api/journeys';
import type { TripDetails, TripPosition, TripStopTime } from '../api/trips';
import { t, useT } from '../i18n';
import { colors, space, themed, type } from '../theme';
import { busSourceText, busText, isBusShown, placeBusOnTrip } from '../utils/busPosition';
import { formatTime } from '../utils/time';
import { placeOnTrip, positionAgeS, ridingText, sourceText, trackY } from '../utils/trainPosition';
import { TrainDot } from './journey';

const TIME_W = 64;
const TRACK = 24;
const ROW_H = 40;
const NODE_TOP = 10;

/** The status line above the stops: where the train is, or why there is no position. */
export function TripStatus({
  trip,
  pos,
  bus,
  leg,
  now,
  tracked,
}: {
  trip: TripDetails;
  pos: TripPosition | null;
  /** The EMT bus of `leg`, when the trip is a bus's. */
  bus?: BusPosition | null;
  leg?: Leg | null;
  now: number;
  tracked: boolean;
}) {
  const { t } = useT();
  const placed = pos ? placeOnTrip(pos, now) : null;
  const late = trip.delay_s ? Math.round(trip.delay_s / 60) : 0;
  let main: string | null = null;
  let detail: string | null = null;
  if (pos && placed) {
    main = ridingText(pos, placed.at);
    detail = sourceText(pos, positionAgeS(pos, now));
  } else if (pos?.status === 'unavailable' && pos.message) {
    detail = pos.message;
  } else if (bus && leg && isBusShown(bus, now)) {
    main = busText(bus, leg, now);
    detail = busSourceText(bus, now, false);
  } else if (bus?.status === 'unavailable' && bus.message) {
    detail = bus.message;
  } else if (!tracked) {
    detail = t('trip.notTracked');
  }
  if (!main && !detail && late <= 0) return null;
  return (
    <View style={styles.status}>
      {main ? <Text style={styles.live}>{main}</Text> : null}
      {detail ? <Text style={styles.small}>{detail}</Text> : null}
      {late > 0 ? (
        <Text style={[styles.small, { color: colors.delay }]}>
          {t('trip.runningLate', { n: late })}
        </Text>
      ) : null}
    </View>
  );
}

export function TripRoute({
  trip,
  color,
  pos,
  bus,
  leg,
  now,
}: {
  trip: TripDetails;
  color: string;
  pos: TripPosition | null;
  bus?: BusPosition | null;
  leg?: Leg | null;
  now: number;
}) {
  const { t } = useT();
  const [ys, setYs] = useState<Record<number, number>>({});
  const measure = (i: number) => (e: LayoutChangeEvent) => {
    const value = e.nativeEvent.layout.y + NODE_TOP + 7;
    setYs((prev) => (prev[i] === value ? prev : { ...prev, [i]: value }));
  };

  const stops = trip.stops;
  const last = stops.length - 1;
  const board = trip.board_index ?? 0;
  const alight = trip.alight_index ?? last;
  const inSection = (a: number, b: number) => a >= board && b <= alight;

  const placed = pos
    ? placeOnTrip(pos, now)
    : bus && leg
      ? placeBusOnTrip(bus, leg, trip, now)
      : null;
  const dotY = placed
    ? trackY(
        stops.map((_, i) => ys[i]),
        placed.row,
        placed.progress,
      )
    : null;
  const passed = (i: number) =>
    !!placed && (i < placed.row || (i === placed.row && !placed.at && placed.row < last));
  const late = trip.delay_s ? Math.round(trip.delay_s / 60) : 0;

  return (
    <View style={{ paddingVertical: space.sm }}>
      {stops.map((s, i) => {
        const key = i === board || i === alight;
        const ends = i === 0 || i === last;
        const time =
          i === alight || i === last ? (s.arrival ?? s.departure) : (s.departure ?? s.arrival);
        const faded = passed(i);
        return (
          <View
            key={`${i}:${s.stop_id}`}
            style={[styles.row, key && styles.keyRow]}
            onLayout={measure(i)}
            accessibilityLabel={stopLabel(s, time, i, board, alight, faded)}>
            <View style={styles.timeCol}>
              {time ? (
                <Text style={[key ? styles.timeKey : styles.time, faded && styles.passed]}>
                  {formatTime(time)}
                </Text>
              ) : null}
              {late > 0 && !faded && time ? <Text style={styles.delay}>+{late}′</Text> : null}
            </View>
            <View style={styles.track}>
              {i > 0 ? (
                <View
                  style={[
                    styles.seg,
                    { top: 0, height: NODE_TOP + 7, backgroundColor: color },
                    !inSection(i - 1, i) && styles.segOut,
                  ]}
                />
              ) : null}
              {i < last ? (
                <View
                  style={[
                    styles.seg,
                    { top: NODE_TOP + 7, bottom: 0, backgroundColor: color },
                    !inSection(i, i + 1) && styles.segOut,
                  ]}
                />
              ) : null}
              <View
                style={[
                  key || ends ? styles.node : styles.nodeSmall,
                  { borderColor: color },
                  (i < board || i > alight) && styles.segOut,
                ]}
              />
            </View>
            <View style={styles.body}>
              <Text
                style={[key ? styles.nameKey : styles.name, faded && styles.passed]}
                numberOfLines={2}>
                {s.name}
              </Text>
              {i === board && trip.board_index != null ? (
                <Text style={styles.tag}>{t('trip.getOn')}</Text>
              ) : null}
              {i === alight && trip.alight_index != null ? (
                <Text style={styles.tag}>{t('trip.getOff')}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
      {dotY != null ? <TrainDot y={dotY} estimated={pos?.kind === 'estimated'} /> : null}
    </View>
  );
}

function stopLabel(
  s: TripStopTime,
  time: string | null | undefined,
  i: number,
  board: number,
  alight: number,
  passed: boolean,
): string {
  const parts = [s.name];
  if (time) parts.push(formatTime(time));
  if (i === board) parts.push(t('trip.a11yGetOn'));
  if (i === alight) parts.push(t('trip.a11yGetOff'));
  if (passed) parts.push(t('trip.a11yPassed'));
  return parts.join(', ');
}

const styles = themed(() => StyleSheet.create({
  status: { paddingHorizontal: space.lg, paddingTop: space.md, gap: 2 },
  live: { ...type.smallStrong, color: colors.live },
  small: { ...type.small, color: colors.textMuted },
  row: { flexDirection: 'row', paddingHorizontal: space.lg, minHeight: ROW_H },
  keyRow: { backgroundColor: colors.bg },
  timeCol: { width: TIME_W, paddingTop: NODE_TOP - 1, flexDirection: 'row', gap: 4 },
  time: { ...type.small, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  timeKey: { ...type.bodyStrong, color: colors.text, fontVariant: ['tabular-nums'] },
  delay: { ...type.smallStrong, color: colors.delay },
  track: { width: TRACK, alignItems: 'center' },
  seg: { position: 'absolute', width: 5 },
  segOut: { opacity: 0.3 },
  node: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 3,
    backgroundColor: colors.surface,
    marginTop: NODE_TOP,
    zIndex: 1,
  },
  nodeSmall: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    backgroundColor: colors.surface,
    marginTop: NODE_TOP + 2,
    zIndex: 1,
  },
  body: { flex: 1, paddingLeft: space.sm, paddingTop: NODE_TOP - 2, paddingBottom: space.sm },
  name: { ...type.small, color: colors.text },
  nameKey: { ...type.bodyStrong, color: colors.text },
  tag: { ...type.smallStrong, color: colors.brand, marginTop: 2 },
  passed: { color: colors.textFaint },
}));
