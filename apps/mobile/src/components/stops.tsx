// Stop rows (search results, favourites) and departure-board rows.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Departure, FrequencyService, Line, Mode } from '../api/stops';
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

/** One scheduled departure: time | line | destination and label | countdown ("6 min"). */
export function DepartureRow({ dep, now }: { dep: Departure; now: number }) {
  const soon = countdown(dep.time, now);
  return (
    <View
      style={styles.dep}
      accessible
      accessibilityLabel={`${dep.line.short_name} to ${dep.headsign ?? 'unknown'}, scheduled ${formatTime(dep.time)}`}>
      <View style={styles.depTime}>
        <Text style={[type.timeL, { color: colors.text }]}>{formatTime(dep.time)}</Text>
      </View>
      <View style={styles.depLine}>
        <LinePill line={dep.line} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.depHeadsign} numberOfLines={2}>
          {dep.headsign ?? '—'}
        </Text>
        <View style={styles.depBadges}>
          <StatusBadge status="scheduled" />
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
