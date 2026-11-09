// Stop rows (search results, favourites) and departure-board rows.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Departure, FrequencyService, Line, LiveArrival, Mode } from '../api/stops';
import { bestTime } from '../api/stops';
import { colors, space, type } from '../theme';
import { countdown, formatTime } from '../utils/time';
import { LinePill, LinePills, ModeIcon, StatusBadge } from './transit';

export function StopRow({
  name,
  modes,
  lines,
  detail,
  onPress,
  trailing,
}: {
  name: string;
  modes: Mode[];
  lines: Line[];
  detail?: string | null;
  onPress: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}${detail ? `, ${detail}` : ''}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.modeCol}>
        <ModeIcon mode={modes[0] ?? 'bus'} size={22} color={colors.brand} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {name}
        </Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
        {lines.length ? <LinePills lines={lines} /> : null}
      </View>
      {trailing ?? (
        <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textFaint} />
      )}
    </Pressable>
  );
}

/** Minutes of delay to show, rounded; 0 hides the delay. */
function delayMinutes(dep: Departure): number {
  const d = dep.realtime?.delay_s;
  return d ? Math.round(d / 60) : 0;
}

/**
 * One departure: scheduled time (+ delay) | line | destination and label | countdown.
 * The scheduled time is always shown; a live estimate is shown next to it, never instead.
 */
export function DepartureRow({ dep, now }: { dep: Departure; now: number }) {
  const cancelled = dep.status === 'cancelled';
  const live = dep.status === 'live' && dep.realtime;
  const delay = live ? delayMinutes(dep) : 0;
  const soon = cancelled ? null : countdown(bestTime(dep), now);
  const platform = dep.realtime?.platform;
  const label = cancelled
    ? `${dep.line.short_name} to ${dep.headsign ?? 'unknown'}, scheduled ${formatTime(dep.time)}, cancelled`
    : live
      ? `${dep.line.short_name} to ${dep.headsign ?? 'unknown'}, scheduled ${formatTime(dep.time)}, ${
          delay > 0 ? `${delay} minutes late` : delay < 0 ? `${-delay} minutes early` : 'on time'
        }`
      : `${dep.line.short_name} to ${dep.headsign ?? 'unknown'}, scheduled ${formatTime(dep.time)}`;
  return (
    <View
      style={[styles.dep, cancelled && styles.depCancelled]}
      accessible
      accessibilityLabel={label}>
      <View style={styles.depTime}>
        <Text style={[type.timeL, { color: colors.text }, cancelled && styles.struck]}>
          {formatTime(dep.time)}
        </Text>
        {delay !== 0 ? (
          <Text style={[type.smallStrong, delay > 0 ? styles.late : styles.early]}>
            {delay > 0 ? '+' : '−'}
            {Math.abs(delay)}′
          </Text>
        ) : null}
      </View>
      <View style={styles.depLine}>
        <LinePill line={dep.line} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.depHeadsign, cancelled && styles.struck]} numberOfLines={2}>
          {dep.headsign ?? '—'}
        </Text>
        <View style={styles.depBadges}>
          {cancelled ? (
            <StatusBadge status="cancelled" />
          ) : live ? (
            <StatusBadge
              status="live"
              text={dep.realtime?.estimated_from_trip_delay ? 'Live · est.' : 'Live'}
            />
          ) : (
            <StatusBadge status="scheduled" />
          )}
          {live && delay !== 0 && dep.realtime?.predicted_time ? (
            <Text style={styles.until}>now {formatTime(dep.realtime.predicted_time)}</Text>
          ) : null}
          {platform ? <Text style={styles.until}>Platform {platform}</Text> : null}
          {dep.wheelchair_accessible ? (
            <MaterialCommunityIcons
              name="wheelchair-accessibility"
              size={16}
              color={colors.textMuted}
              accessibilityLabel="Wheelchair accessible"
            />
          ) : null}
        </View>
      </View>
      <Text style={[styles.countdown, !soon && styles.countdownEmpty]}>
        {soon?.replace('in ', '') ?? ''}
      </Text>
    </View>
  );
}

/** A live EMT prediction: minutes away, with no timetable behind it. */
export function LiveArrivalRow({ a, now }: { a: LiveArrival; now: number }) {
  const mins = a.time ? Math.max(0, Math.floor((Date.parse(a.time) - now) / 60_000)) : null;
  const text = mins === null ? '>45′' : mins === 0 ? 'now' : `${mins}′`;
  return (
    <View
      style={styles.dep}
      accessible
      accessibilityLabel={`${a.line.short_name} to ${a.headsign ?? 'unknown'}, live, ${
        mins === null ? 'more than 45 minutes' : mins === 0 ? 'arriving now' : `in ${mins} minutes`
      }`}>
      <View style={styles.depTime}>
        <Text style={[type.timeL, { color: colors.live }]}>{text}</Text>
      </View>
      <View style={styles.depLine}>
        <LinePill line={a.line} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.depHeadsign} numberOfLines={2}>
          {a.headsign ?? '—'}
        </Text>
        <View style={styles.depBadges}>
          <StatusBadge status="live" />
          {a.time ? <Text style={styles.until}>about {formatTime(a.time)}</Text> : null}
        </View>
      </View>
    </View>
  );
}

/** A frequency-based line (Metro, EMT): no exact times exist, so none are shown. */
export function FrequencyRow({ f }: { f: FrequencyService }) {
  return (
    <View
      style={styles.dep}
      accessible
      accessibilityLabel={`${f.line.short_name} to ${f.headsign ?? 'unknown'}, about every ${f.headway_min} minutes`}>
      <View style={styles.depTime}>
        <Text style={[type.timeL, { color: colors.text }]}>~{f.headway_min}′</Text>
      </View>
      <View style={styles.depLine}>
        <LinePill line={f.line} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.depHeadsign} numberOfLines={2}>
          {f.headsign ?? '—'}
        </Text>
        <View style={styles.depBadges}>
          <StatusBadge status="frequency" text={`Every ~${f.headway_min} min`} />
          <Text style={styles.until}>until {formatTime(f.until_time)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: '#F8F9FB' },
  modeCol: { width: 28, alignItems: 'center' },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { ...type.bodyStrong, color: colors.text },
  rowDetail: { ...type.small, color: colors.textMuted },
  dep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: colors.surface,
  },
  depTime: { width: 60 },
  depCancelled: { opacity: 0.75 },
  struck: { textDecorationLine: 'line-through', color: colors.textMuted },
  late: { color: colors.delay },
  early: { color: colors.live },
  countdown: {
    ...type.time,
    color: colors.brand,
    minWidth: 52,
    textAlign: 'right',
    paddingTop: 2,
  },
  countdownEmpty: { minWidth: 0 },
  depLine: { width: 52, alignItems: 'flex-start', paddingTop: 1 },
  depHeadsign: { ...type.bodyStrong, color: colors.text },
  depBadges: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 4 },
  until: { ...type.small, color: colors.textMuted },
});
