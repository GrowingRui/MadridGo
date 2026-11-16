// Live trains on Plan > Map: the switch, the line filter, the status line (how many trains,
// where the data comes from, what a hollow point means) and the card of a tapped train.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Line } from '../api/stops';
import type { LiveTrain } from '../api/trains';
import { useT } from '../i18n';
import { colors, radius, space, themed, type } from '../theme';
import { standing } from '../utils/liveTrains';
import { formatTime } from '../utils/time';
import { positionAgeS, ridingText, sourceText } from '../utils/trainPosition';
import { LinePill, StatusBadge } from './transit';

export function LiveTrainsSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { t } = useT();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={t('trains.toggle')}
      accessibilityHint={t('trains.toggleHint')}
      style={({ pressed }) => [
        styles.switch,
        on && styles.switchOn,
        pressed && !on && { backgroundColor: colors.brandTint },
      ]}>
      <MaterialCommunityIcons name="train" size={20} color={on ? colors.onPrimary : colors.brand} />
      <Text style={[styles.switchText, on && { color: colors.onPrimary }]}>{t('trains.toggle')}</Text>
    </Pressable>
  );
}

/** "All lines" and one chip per line with trains on the map. */
export function LineFilter({
  lines,
  selected,
  onSelect,
}: {
  lines: Line[];
  selected: string | null;
  onSelect: (line: string | null) => void;
}) {
  const { t } = useT();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
      keyboardShouldPersistTaps="handled">
      <Chip on={selected == null} onPress={() => onSelect(null)} label={t('trains.all')}>
        <Text style={[styles.chipText, selected == null && styles.chipTextOn]}>
          {t('trains.all')}
        </Text>
      </Chip>
      {lines.map((line) => (
        <Chip
          key={line.short_name}
          on={selected === line.short_name}
          onPress={() => onSelect(selected === line.short_name ? null : line.short_name)}
          label={line.short_name}>
          <LinePill line={line} size="sm" />
        </Chip>
      ))}
    </ScrollView>
  );
}

function Chip({
  on,
  onPress,
  label,
  children,
}: {
  on: boolean;
  onPress: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.chip,
        on && styles.chipOn,
        pressed && !on && { backgroundColor: colors.brandTint },
      ]}>
      {children}
    </Pressable>
  );
}

/** Under the map while no train is open: how many trains, or why there are none. */
export function TrainsStatus({ text, tone }: { text: string; tone: 'info' | 'problem' }) {
  const { t } = useT();
  return (
    <View style={styles.status} accessibilityLiveRegion="polite">
      <Text style={[styles.statusText, tone === 'problem' && { color: colors.warning }]}>{text}</Text>
      <Text style={styles.legend}>{t('trains.legend')}</Text>
    </View>
  );
}

/** A tapped train: line, direction, where it is, how late, the next stop. */
export function TrainCard({
  train,
  now,
  onClose,
  onShowStops,
}: {
  train: LiveTrain;
  now: number;
  onClose: () => void;
  onShowStops: () => void;
}) {
  const { t } = useT();
  const live = train.kind === 'live';
  const late = train.delay_s != null ? Math.round(train.delay_s / 60) : null;
  const at = standing(train, now);
  const next = train.next_stop;
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.inner}>
        <View style={styles.top}>
          {train.line ? <LinePill line={train.line} /> : null}
          {train.headsign ? (
            <Text style={styles.direction} numberOfLines={1}>
              {t('conn.direction', { name: train.headsign })}
            </Text>
          ) : null}
          {live ? <StatusBadge status="live" /> : null}
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}>
            <MaterialCommunityIcons name="close" size={22} color={colors.textMuted} />
          </Pressable>
        </View>
        <Text style={styles.main}>{ridingText(train, at)}</Text>
        <Text style={styles.small}>{sourceText(train, positionAgeS(train, now))}</Text>
        {late != null ? (
          <Text style={[styles.small, late > 0 ? { color: colors.delay } : { color: colors.live }]}>
            {late > 0 ? t('trains.late', { n: late }) : t('trains.onTime')}
          </Text>
        ) : null}
        {next && train.expected_at_next ? (
          <View style={styles.row}>
            <Text style={styles.rowLabel} numberOfLines={2}>
              {t('liveMap.nextStop', { stop: next.name })}
            </Text>
            <Text style={styles.time}>{formatTime(train.expected_at_next)}</Text>
          </View>
        ) : null}
        <Pressable
          onPress={onShowStops}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}>
          <Text style={styles.buttonText}>{t('trains.showStops')}</Text>
          <MaterialCommunityIcons name="chevron-right" size={20} color={colors.onPrimary} />
        </Pressable>
      </View>
    </View>
  );
}

const shadow = Platform.select({
  web: { boxShadow: '0 2px 10px rgba(0,0,0,0.18)' } as object,
  default: { elevation: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
});

const styles = themed(() =>
  StyleSheet.create({
    switch: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      alignSelf: 'flex-start',
      backgroundColor: colors.surface,
      borderRadius: 999,
      paddingHorizontal: space.md,
      height: 40,
      ...shadow,
    },
    switchOn: { backgroundColor: colors.primary },
    switchText: { ...type.bodyStrong, color: colors.brand },
    chips: { gap: space.xs, paddingVertical: space.xs, paddingRight: space.lg },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 999,
      borderWidth: 2,
      borderColor: colors.surface,
      paddingHorizontal: space.sm,
      height: 36,
      ...shadow,
    },
    chipOn: { borderColor: colors.primary },
    chipText: { ...type.small, color: colors.text },
    chipTextOn: { color: colors.brand, fontWeight: '700' },
    status: {
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      alignItems: 'center',
    },
    statusText: { ...type.bodyStrong, color: colors.text, textAlign: 'center' },
    legend: { ...type.small, color: colors.textMuted, textAlign: 'center' },
    card: {
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: space.lg,
      paddingTop: space.md,
      paddingBottom: space.lg,
    },
    inner: { width: '100%', maxWidth: 720, alignSelf: 'center', gap: space.xs },
    top: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    direction: { ...type.bodyStrong, color: colors.text, flexShrink: 1 },
    main: { ...type.bodyStrong, color: colors.text, marginTop: space.xs },
    small: { ...type.small, color: colors.textMuted },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.md,
      marginTop: space.xs,
    },
    rowLabel: { ...type.body, color: colors.text, flexShrink: 1 },
    time: { ...type.timeL, color: colors.text },
    button: {
      marginTop: space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.xs,
      backgroundColor: colors.primary,
      borderRadius: radius.md,
      paddingVertical: space.sm,
    },
    buttonText: { ...type.bodyStrong, color: colors.onPrimary },
  }),
);
