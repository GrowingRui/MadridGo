// Transit building blocks: line pictograms, mode icons and reliability labels.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { StyleSheet, Text, View } from 'react-native';

import type { LegTime, TimeStatus, TransferLabel } from '../api/journeys';
import { delayMin, shownTime } from '../api/journeys';
import type { Line, Mode } from '../api/stops';
import { t, useT } from '../i18n';
import { colors, modeColors, radius, type } from '../theme';
import { formatTime } from '../utils/time';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

const MODE_ICON: Record<Mode | 'walk', IconName> = {
  rail: 'train',
  metro: 'subway-variant',
  light_rail: 'tram',
  bus: 'bus',
  walk: 'walk',
};

/** "Cercanías", "Metro", "Bus" / "Autobús"… in the app language. */
export function modeLabel(mode: Mode | 'walk'): string {
  return t(`mode.${mode}`);
}

export function ModeIcon({
  mode,
  size = 18,
  color = colors.textMuted,
}: {
  mode: Mode | 'walk';
  size?: number;
  color?: string;
}) {
  useT();
  return (
    <MaterialCommunityIcons
      name={MODE_ICON[mode]}
      size={size}
      color={color}
      accessibilityLabel={modeLabel(mode)}
    />
  );
}

export function lineColors(line: Line): { bg: string; fg: string } {
  const fallback = modeColors[line.mode] ?? modeColors.bus;
  return {
    bg: line.color ? `#${line.color}` : fallback.bg,
    fg: line.text_color ? `#${line.text_color}` : fallback.fg,
  };
}

/** Line pictogram: Metro lines are round (as on Madrid signage), everything else a rounded box. */
export function LinePill({
  line,
  size = 'md',
  onDark,
}: {
  line: Line;
  size?: 'sm' | 'md';
  /** On the navy header: a thin white outline keeps dark lines (C4 navy) visible. */
  onDark?: boolean;
}) {
  useT();
  const { bg, fg } = lineColors(line);
  const small = size === 'sm';
  const round = line.mode === 'metro' && line.short_name.length <= 2;
  return (
    <View
      accessibilityLabel={`${modeLabel(line.mode)} ${line.short_name}`}
      style={[
        styles.pill,
        small && styles.pillSm,
        { backgroundColor: bg },
        round && { borderRadius: radius.pill, minWidth: small ? 20 : 26, paddingHorizontal: 0 },
        onDark && styles.pillOnDark,
      ]}>
      <Text style={[styles.pillText, small && styles.pillTextSm, { color: fg }]} numberOfLines={1}>
        {line.short_name}
      </Text>
    </View>
  );
}

export function LinePills({
  lines,
  max = 8,
  onDark,
}: {
  lines: Line[];
  max?: number;
  onDark?: boolean;
}) {
  const shown = lines.slice(0, max);
  return (
    <View style={styles.pills}>
      {shown.map((l) => (
        <LinePill key={`${l.source}:${l.route_id}`} line={l} size="sm" onDark={onDark} />
      ))}
      {lines.length > max ? <Text style={styles.more}>+{lines.length - max}</Text> : null}
    </View>
  );
}

export type BadgeStatus = TimeStatus;

const STATUS_STYLE: Record<BadgeStatus, { fg: string; bg: string }> = {
  live: { fg: colors.live, bg: colors.liveBg },
  cancelled: { fg: colors.delay, bg: colors.delayBg },
  scheduled: { fg: colors.scheduled, bg: colors.scheduledBg },
  frequency: { fg: colors.warning, bg: colors.warningBg },
};

/** The reliability label. Every time in the app is shown next to one of these. */
export function StatusBadge({ status, text }: { status: BadgeStatus; text?: string }) {
  const { t } = useT();
  const s = { ...STATUS_STYLE[status], label: t(`status.${status}`) };
  return (
    <View style={[styles.badge, { backgroundColor: s.bg }]}>
      {status === 'live' ? <View style={[styles.liveDot, { backgroundColor: s.fg }]} /> : null}
      <Text style={[styles.badgeText, { color: s.fg }]}>{text ?? s.label}</Text>
    </View>
  );
}

const TRANSFER_STYLE: Record<TransferLabel, { fg: string; bg: string }> = {
  comfortable: { fg: colors.live, bg: colors.liveBg },
  tight: { fg: colors.warning, bg: colors.warningBg },
  at_risk: { fg: colors.delay, bg: colors.delayBg },
  not_feasible: { fg: colors.delay, bg: colors.delayBg },
  uncertain: { fg: colors.scheduled, bg: colors.scheduledBg },
};

/** How safe a change is (RELIABILITY_STRATEGY.md §5). Words only, never a percentage. */
export function TransferBadge({ label }: { label: TransferLabel }) {
  const { t } = useT();
  const s = TRANSFER_STYLE[label];
  return (
    <View style={[styles.badge, { backgroundColor: s.bg }]}>
      <Text style={[styles.badgeText, { color: s.fg }]}>{t(`transfer.${label}`)}</Text>
    </View>
  );
}

/** A time with its delay: "17:54 +4'" where the delay is red. Struck-through when cancelled. */
export function TimeWithDelay({ time, big }: { time: LegTime; big?: boolean }) {
  const { t } = useT();
  const d = delayMin(time);
  const cancelled = time.status === 'cancelled';
  return (
    <View style={styles.timeRow}>
      <Text
        style={[
          big ? type.timeXL : type.timeL,
          { color: cancelled ? colors.textFaint : colors.text },
          cancelled && { textDecorationLine: 'line-through' },
        ]}>
        {formatTime(shownTime(time))}
      </Text>
      {d > 0 ? (
        <Text
          style={[type.smallStrong, styles.delay]}
          accessibilityLabel={t('a11y.minutesLate', { n: d })}>
          +{d}′
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    minWidth: 30,
    height: 24,
    paddingHorizontal: 6,
    borderRadius: radius.sm - 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillOnDark: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)' },
  pillSm: { minWidth: 24, height: 20, paddingHorizontal: 5 },
  pillText: { fontSize: 13, fontWeight: '800' },
  pillTextSm: { fontSize: 11 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  more: { ...type.small, color: colors.textMuted, marginLeft: 2 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm - 2,
  },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  timeRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  delay: { color: colors.delay },
});
