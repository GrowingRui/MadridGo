// Planner building blocks: the From/To card on the navy header (stacked in the app, in one row on
// the website), departure-time chips, the "pearl chain" journey line and the connection row.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Fragment, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Journey, Leg } from '../api/journeys';
import { delayMin } from '../api/journeys';
import type { Place } from '../state/planner';
import { colors, modeColors, radius, space, type } from '../theme';
import { countdown, formatDuration, formatTime } from '../utils/time';
import { LinePill, ModeIcon, StatusBadge, TimeWithDelay, lineColors } from './transit';

// ---------------------------------------------------------------------------
// From / To

export type PlaceFieldName = 'from' | 'to';

/**
 * From/To card. Tapping a field turns it into a text box in place (no separate page); the
 * suggestions are rendered by the screen under the header (app) or as a dropdown under the
 * field (website, `dropdown`).
 */
export function PlannerCard({
  from,
  to,
  onSwap,
  editing,
  text,
  onEdit,
  onText,
  onClose,
  layout = 'stacked',
  dropdown,
}: {
  from: Place | null;
  to: Place | null;
  onSwap: () => void;
  editing: PlaceFieldName | null;
  text: string;
  onEdit: (field: PlaceFieldName) => void;
  onText: (text: string) => void;
  onClose: () => void;
  layout?: 'stacked' | 'row';
  dropdown?: ReactNode;
}) {
  const field = (name: PlaceFieldName) => (
    <PlaceField
      label={name === 'from' ? 'From' : 'To'}
      place={name === 'from' ? from : to}
      placeholder={name === 'from' ? 'Stop or station' : 'Where to?'}
      active={editing === name}
      text={text}
      onPress={() => onEdit(name)}
      onText={onText}
      onClose={onClose}
    />
  );

  if (layout === 'row') {
    return (
      <View style={styles.plannerRow}>
        {(['from', 'to'] as const).map((name, i) => (
          <Fragment key={name}>
            {i === 1 ? <SwapButton onSwap={onSwap} icon="swap-horizontal" /> : null}
            <View style={[styles.rowField, editing === name && styles.rowFieldActive]}>
              <View
                style={[
                  styles.railDot,
                  name === 'from' ? styles.railDotOpen : styles.railDotFilled,
                ]}
              />
              {field(name)}
              {editing === name && dropdown ? (
                <View style={styles.dropdown}>{dropdown}</View>
              ) : null}
            </View>
          </Fragment>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.planner}>
      <View style={styles.rail}>
        <View style={[styles.railDot, styles.railDotOpen]} />
        <View style={styles.railLine} />
        <View style={[styles.railDot, styles.railDotFilled]} />
      </View>
      <View style={{ flex: 1 }}>
        {field('from')}
        <View style={styles.fieldDivider} />
        {field('to')}
      </View>
      {editing ? null : <SwapButton onSwap={onSwap} icon="swap-vertical" />}
    </View>
  );
}

function SwapButton({
  onSwap,
  icon,
}: {
  onSwap: () => void;
  icon: 'swap-vertical' | 'swap-horizontal';
}) {
  return (
    <Pressable
      onPress={onSwap}
      accessibilityRole="button"
      accessibilityLabel="Swap origin and destination"
      hitSlop={8}
      style={({ pressed }) => [styles.swap, pressed && { backgroundColor: colors.brandTint }]}>
      <MaterialCommunityIcons name={icon} size={22} color={colors.brand} />
    </Pressable>
  );
}

function PlaceField({
  label,
  place,
  placeholder,
  active,
  text,
  onPress,
  onText,
  onClose,
}: {
  label: string;
  place: Place | null;
  placeholder: string;
  active: boolean;
  text: string;
  onPress: () => void;
  onText: (text: string) => void;
  onClose: () => void;
}) {
  if (active) {
    return (
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.brand }]}>{label}</Text>
        <View style={styles.inputRow}>
          <TextInput
            autoFocus
            value={text}
            onChangeText={onText}
            placeholder={place?.name ?? 'Stop, station or stop code'}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel={`${label}: search stops`}
            // The highlighted field is the focus indicator; hide the browser's focus ring.
            {...(Platform.OS === 'web'
              ? { style: [styles.input, { outlineStyle: 'none' } as object] }
              : null)}
            onKeyPress={(e) => {
              if (e.nativeEvent.key === 'Escape') onClose();
            }}
          />
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close search"
            hitSlop={10}>
            <MaterialCommunityIcons name="close" size={20} color={colors.textMuted} />
          </Pressable>
        </View>
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${place?.name ?? placeholder}`}
      style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, !place && { color: colors.textFaint }]} numberOfLines={1}>
        {place?.name ?? placeholder}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Departure time

export const OFFSETS = [
  { label: 'Now', min: 0 },
  { label: '+15 min', min: 15 },
  { label: '+30 min', min: 30 },
  { label: '+1 h', min: 60 },
];

/** "Now / +15 / +30 / +1 h" chips on the navy header. */
export function WhenChips({
  active,
  onChange,
}: {
  active: number;
  onChange: (offsetMin: number) => void;
}) {
  return (
    <View style={styles.whenRow} accessibilityRole="radiogroup" accessibilityLabel="Departure">
      <MaterialCommunityIcons name="clock-outline" size={18} color={colors.onBrandMuted} />
      {OFFSETS.map((o) => {
        const on = o.min === active;
        return (
          <Pressable
            key={o.label}
            onPress={() => onChange(o.min)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[styles.chip, on && styles.chipActive]}>
            <Text style={[styles.chipText, on && styles.chipTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pearl chain

/**
 * The journey as one line: a segment per leg sized by its duration and coloured by its line,
 * with a pearl where you board, change and arrive. Walking is a dotted grey segment.
 */
export function PearlChain({ legs }: { legs: Leg[] }) {
  const total = legs.reduce((s, l) => s + l.duration_min, 0) || 1;
  return (
    <View style={styles.chain} accessibilityElementsHidden importantForAccessibility="no">
      <View style={[styles.pearl, styles.pearlEnd]} />
      {legs.map((leg, i) => {
        const flex = Math.max(leg.duration_min / total, 0.07);
        const walk = leg.mode === 'walk' || !leg.line;
        // A pearl between two legs marks a change (none between walking and riding).
        const change = i > 0 && !walk && legs[i - 1].mode !== 'walk';
        return (
          <Fragment key={i}>
            {change ? <View style={styles.pearl} /> : null}
            {walk ? (
              <View style={[styles.chainWalk, { flex }]}>
                <View style={styles.chainDots} />
              </View>
            ) : (
              <View
                style={[styles.chainSeg, { flex, backgroundColor: lineColors(leg.line!).bg }]}
              />
            )}
          </Fragment>
        );
      })}
      <View style={[styles.pearl, styles.pearlEnd]} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connection row

export function journeyStatus(j: Journey) {
  const transit = j.legs.filter((l) => l.mode !== 'walk');
  if (transit.some((l) => l.departure.status === 'live')) return 'live' as const;
  if (transit.some((l) => l.departure.status === 'frequency')) return 'frequency' as const;
  return 'scheduled' as const;
}

export function changesLabel(n: number) {
  return n === 0 ? 'Direct' : `${n} change${n > 1 ? 's' : ''}`;
}

/**
 * One connection, laid out like a timetable row:
 *   [C4] Direction Parla                  in 6 min
 *   17:54  ●━━━━━━━━○━━━━━━━━●  18:40
 *   Pl. 2 · Scheduled               46 min · Direct
 */
export function ConnectionCard({
  journey,
  onPress,
  now,
  selected,
}: {
  journey: Journey;
  onPress: () => void;
  now: number;
  selected?: boolean;
}) {
  const transit = journey.legs.filter((l) => l.mode !== 'walk');
  const first = transit[0];
  const delay = delayMin(journey.arrival);
  const status = journeyStatus(journey);
  const mixed = status === 'live' && transit.some((l) => l.departure.status !== 'live');
  const soon = countdown(journey.departure.estimated ?? journey.departure.scheduled, now);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Departs ${formatTime(journey.departure.scheduled)}, arrives ${formatTime(
        journey.arrival.scheduled,
      )}, ${formatDuration(journey.duration_min)}, ${changesLabel(journey.transfers)}`}
      style={({ pressed, hovered }) => [
        styles.conn,
        (pressed || hovered) && { backgroundColor: '#F7F8FA' },
        selected && styles.connSelected,
      ]}>
      <View style={styles.connTop}>
        <View style={styles.connLines}>
          {transit.map((l, i) =>
            l.line ? <LinePill key={i} line={l.line} /> : <ModeIcon key={i} mode={l.mode} />,
          )}
          {first?.headsign ? (
            <Text style={styles.direction} numberOfLines={1}>
              Direction {first.headsign}
            </Text>
          ) : null}
        </View>
        {soon ? <Text style={styles.countdown}>{soon}</Text> : null}
      </View>

      <View style={styles.connTimes}>
        <TimeWithDelay time={journey.departure} big />
        <View style={styles.chainWrap}>
          <PearlChain legs={journey.legs} />
        </View>
        <TimeWithDelay time={journey.arrival} big />
      </View>

      <View style={styles.connMeta}>
        <View style={styles.metaLeft}>
          {first?.departure.platform ? (
            <Text style={styles.platform}>Pl. {first.departure.platform}</Text>
          ) : null}
          <StatusBadge status={status} text={mixed ? 'Partly live' : undefined} />
        </View>
        <Text style={styles.meta}>
          <Text style={styles.metaStrong}>{formatDuration(journey.duration_min)}</Text>
          {' · '}
          {changesLabel(journey.transfers)}
        </Text>
      </View>
      {delay > 0 ? (
        <Text style={styles.delayNote}>Arrives about {delay} min late (live data)</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // From / To
  planner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: space.xs,
    paddingLeft: space.md,
    paddingRight: space.sm,
    marginTop: space.lg,
  },
  plannerRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.xs,
    minHeight: 64,
    zIndex: 20,
  },
  rowField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  rowFieldActive: { backgroundColor: colors.brandTint },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: space.sm,
    maxHeight: 440,
    overflow: 'scroll',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    boxShadow: '0 12px 32px rgba(11, 58, 130, 0.18)',
    zIndex: 20,
  },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // outlineWidth 0: the highlighted field is the focus indicator; the browser ring looked broken.
  input: {
    flex: 1,
    ...type.bodyStrong,
    color: colors.text,
    paddingVertical: 1,
    outlineWidth: 0,
    borderWidth: 0,
    minWidth: 0,
  },
  rail: { alignItems: 'center', marginRight: space.md, paddingVertical: space.md },
  railDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    backgroundColor: colors.surface,
  },
  railDotOpen: { borderColor: colors.brand },
  railDotFilled: { backgroundColor: colors.brand, borderColor: colors.brand },
  railLine: { width: 2, height: 34, backgroundColor: colors.border, marginVertical: 3 },
  field: { paddingVertical: space.sm, flex: 1 },
  fieldLabel: { ...type.small, color: colors.textMuted },
  fieldValue: { ...type.bodyStrong, color: colors.text, marginTop: 1 },
  fieldDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  swap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: space.xs,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },

  // Time
  whenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.onBrandMuted,
  },
  chipActive: { backgroundColor: colors.surface, borderColor: colors.surface },
  chipText: { ...type.smallStrong, color: colors.onBrand },
  chipTextActive: { color: colors.brand },

  // Pearl chain
  chain: { flexDirection: 'row', alignItems: 'center', height: 14 },
  chainSeg: { height: 4 },
  chainWalk: { height: 4, justifyContent: 'center' },
  chainDots: {
    height: 0,
    borderTopWidth: 2,
    borderStyle: 'dotted',
    borderColor: modeColors.walk.bg,
  },
  pearl: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.text,
    backgroundColor: colors.surface,
    marginHorizontal: -1,
    zIndex: 1,
  },
  pearlEnd: { backgroundColor: colors.text },

  // Connection row
  conn: {
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: 6,
    backgroundColor: colors.surface,
    borderLeftWidth: 4,
    borderLeftColor: 'transparent',
  },
  connSelected: { backgroundColor: colors.brandTint, borderLeftColor: colors.brand },
  connTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  connLines: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  direction: { ...type.small, color: colors.text, flexShrink: 1 },
  countdown: { ...type.smallStrong, color: colors.brand },
  connTimes: { flexDirection: 'row', alignItems: 'center' },
  chainWrap: { flex: 1, marginHorizontal: space.md },
  connMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metaLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  platform: { ...type.smallStrong, color: colors.text },
  meta: { ...type.small, color: colors.textMuted },
  metaStrong: { ...type.smallStrong, color: colors.text },
  delayNote: { ...type.small, color: colors.delay },
});
