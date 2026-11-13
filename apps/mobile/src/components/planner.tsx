// Planner building blocks: the From/To card on the navy header (stacked in the app, in one row on
// the website) with the date and time row inside it, the "pearl chain" journey line and the
// connection row.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Fragment, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Journey, Leg } from '../api/journeys';
import { delayMin, shownTime } from '../api/journeys';
import { byAlertSeverity, isSevereAlert } from '../api/stops';
import { t, tn, useT } from '../i18n';
import { HERE_ID, type Place } from '../state/planner';
import { colors, modeColors, radius, space, themed, type } from '../theme';
import { countdown, formatDuration, formatTime } from '../utils/time';
import {
  LinePill,
  ModeIcon,
  StatusBadge,
  TimeWithDelay,
  TransferBadge,
  lineColors,
} from './transit';
import type { PressState } from '../hooks';
import { journeyAccess } from '../utils/access';
import { AccessMark } from './access';

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
  footer,
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
  /** A row under the fields, inside the card (the date and time row). */
  footer?: ReactNode;
}) {
  const { t } = useT();
  const field = (name: PlaceFieldName) => (
    <PlaceField
      label={name === 'from' ? t('plan.from') : t('plan.to')}
      place={name === 'from' ? from : to}
      placeholder={name === 'from' ? t('plan.fromPlaceholder') : t('plan.whereTo')}
      active={editing === name}
      text={text}
      onPress={() => onEdit(name)}
      onText={onText}
      onClose={onClose}
    />
  );

  if (layout === 'row') {
    return (
      <View style={styles.cardWide}>
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
        {footer}
      </View>
    );
  }
  return (
    <View style={styles.card}>
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
      {footer}
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
  const { t } = useT();
  return (
    <Pressable
      onPress={onSwap}
      accessibilityRole="button"
      accessibilityLabel={t('plan.swap')}
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
  const { t } = useT();
  if (active) {
    return (
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.brand }]}>{label}</Text>
        <View style={styles.inputRow}>
          <TextInput
            autoFocus
            value={text}
            onChangeText={onText}
            placeholder={place?.name ?? t('search.placeholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel={t('plan.searchLabel', { field: label })}
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
            accessibilityLabel={t('plan.closeSearch')}
            hitSlop={10}>
            <MaterialCommunityIcons name="close" size={20} color={colors.textMuted} />
          </Pressable>
        </View>
      </View>
    );
  }
  // "Current location" follows the app language even if it was picked in another one.
  const here = place?.id === HERE_ID;
  const shown = here ? t('here.title') : (place?.name ?? placeholder);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${shown}`}
      style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldValueRow}>
        {here ? (
          <MaterialCommunityIcons name="crosshairs-gps" size={16} color={colors.brand} />
        ) : place?.lat != null ? (
          // An address or place from the search, not a stop.
          <MaterialCommunityIcons name="map-marker-outline" size={16} color={colors.brand} />
        ) : null}
        <Text
          style={[styles.fieldValue, { flexShrink: 1 }, !place && { color: colors.textFaint }]}
          numberOfLines={1}>
          {shown}
        </Text>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Pearl chain

/**
 * The journey as one line: a segment per leg sized by its duration and coloured by its line,
 * with a pearl where you board, change and arrive. Walking is a dotted grey segment.
 */
/**
 * The connection as a line: one segment per leg sized by its duration, in its line colour,
 * pearls at the ends and at changes. With `now` during the journey (as in SBB's connection
 * header) the part already travelled is grey and an amber dot marks where you should be now.
 */
export function PearlChain({ legs, now }: { legs: Leg[]; now?: number }) {
  const total = legs.reduce((s, l) => s + l.duration_min, 0) || 1;
  const start = Date.parse(shownTime(legs[0].departure));
  const end = Date.parse(shownTime(legs[legs.length - 1].arrival));
  const travelling = now != null && now >= start && now < end;
  const done = now != null && now >= end;
  // 0..1 of each leg already travelled.
  const passed = legs.map((leg) => {
    if (done) return 1;
    if (!travelling) return 0;
    const a = Date.parse(shownTime(leg.departure));
    const b = Date.parse(shownTime(leg.arrival));
    if (now! >= b) return 1;
    if (now! <= a) return 0;
    return (now! - a) / Math.max(b - a, 1);
  });
  const nowLeg = travelling ? passed.findIndex((f) => f < 1) : -1;
  const pearl = (gone: boolean, end?: boolean) => (
    <View
      style={[
        styles.pearl,
        end && styles.pearlEnd,
        gone && styles.pearlGone,
        end && gone && { backgroundColor: colors.textFaint },
      ]}
    />
  );
  return (
    <View style={styles.chain} accessibilityElementsHidden importantForAccessibility="no">
      {pearl(travelling || done, true)}
      {legs.map((leg, i) => {
        const flex = Math.max(leg.duration_min / total, 0.07);
        const walk = leg.mode === 'walk' || !leg.line;
        // A pearl between two legs marks a change (none between walking and riding).
        const change = i > 0 && !walk && legs[i - 1].mode !== 'walk';
        const color = walk ? null : lineColors(leg.line!).bg;
        const piece = (f: number, gone: boolean, key: string) =>
          f <= 0 ? null : walk ? (
            <View key={key} style={[styles.chainWalk, { flex: f }]}>
              <View style={[styles.chainDots, gone && styles.chainDotsGone]} />
            </View>
          ) : (
            <View
              key={key}
              style={[styles.chainSeg, { flex: f, backgroundColor: gone ? colors.textFaint : color! }]}
            />
          );
        return (
          <Fragment key={i}>
            {change ? pearl(passed[i] > 0) : null}
            {piece(flex * passed[i], true, 'gone')}
            {i === nowLeg ? <View style={styles.nowDot} /> : null}
            {piece(flex * (1 - passed[i]), false, 'ahead')}
          </Fragment>
        );
      })}
      {pearl(done, true)}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connection row

export function journeyStatus(j: Journey) {
  const transit = j.legs.filter((l) => l.mode !== 'walk');
  if (transit.some((l) => l.departure.status === 'cancelled')) return 'cancelled' as const;
  if (transit.some((l) => l.departure.status === 'live')) return 'live' as const;
  if (transit.some((l) => l.departure.status === 'frequency')) return 'frequency' as const;
  return 'scheduled' as const;
}

export function changesLabel(n: number) {
  return n === 0 ? t('conn.direct') : tn('conn.changes', n);
}

/**
 * One connection, laid out like a timetable row:
 *   [C4] Direction Parla                  in 6 min
 *   17:54  ●━━━━━━━━○━━━━━━━━●  18:40
 *   Pl. 2 · Scheduled               46 min · Direct
 *   ⚠ No circulan trenes de la C-4 … +1 more      (operator alert on a line used, if any)
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
  const { t } = useT();
  const transit = journey.legs.filter((l) => l.mode !== 'walk');
  const first = transit[0];
  const delay = delayMin(journey.arrival);
  const status = journeyStatus(journey);
  const mixed = status === 'live' && transit.some((l) => l.departure.status !== 'live');
  const soon = countdown(journey.departure.estimated ?? journey.departure.scheduled, now);
  const alerts = byAlertSeverity(journey.alerts);
  const alert = alerts[0];
  const alertText = alert ? (alert.header ?? alert.description ?? t('journey.alertFallback')) : '';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={
        (journey.feasible ? '' : t('conn.a11yNotPossible')) +
        t('conn.a11y', {
          dep: formatTime(shownTime(journey.departure)),
          arr: formatTime(shownTime(journey.arrival)),
          duration: formatDuration(journey.duration_min),
          changes: changesLabel(journey.transfers),
        }) +
        (alert ? `. ${t('conn.a11yAlert', { text: alertText })}` : '')
      }
      style={({ pressed, hovered }: PressState) => [
        styles.conn,
        (pressed || hovered) && { backgroundColor: colors.pressed },
        selected && styles.connSelected,
      ]}>
      <View style={styles.connTop}>
        <View style={styles.connLines}>
          {transit.map((l, i) =>
            l.line ? <LinePill key={i} line={l.line} /> : <ModeIcon key={i} mode={l.mode} />,
          )}
          {first?.headsign ? (
            <Text style={styles.direction} numberOfLines={1}>
              {t('conn.direction', { name: first.headsign })}
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
            <Text style={styles.platform}>
              {t('conn.platformShort', { p: first.departure.platform })}
            </Text>
          ) : null}
          <StatusBadge status={status} text={mixed ? t('status.partlyLive') : undefined} />
          <AccessMark ok={journeyAccess(journey)} />
        </View>
        <Text style={styles.meta}>
          <Text style={styles.metaStrong}>{formatDuration(journey.duration_min)}</Text>
          {' · '}
          {changesLabel(journey.transfers)}
        </Text>
      </View>
      {delay > 0 ? (
        <Text style={styles.delayNote}>{t('conn.arrivesLate', { n: delay })}</Text>
      ) : null}
      {!journey.feasible ? (
        <Text style={styles.delayNote}>{journey.issues[0] ?? t('conn.notPossible')}</Text>
      ) : journey.reliability && journey.reliability !== 'comfortable' ? (
        <TransferBadge label={journey.reliability} />
      ) : null}
      {alert ? (
        <CardAlert severe={isSevereAlert(alert)} text={alertText} more={alerts.length - 1} />
      ) : null}
    </Pressable>
  );
}

/** One line on the connection card; the full alert texts are in the journey's notices. */
function CardAlert({ severe, text, more }: { severe: boolean; text: string; more: number }) {
  useT();
  const fg = severe ? colors.delay : colors.warning;
  return (
    <View style={[styles.alert, { backgroundColor: severe ? colors.delayBg : colors.warningBg }]}>
      <MaterialCommunityIcons
        name={severe ? 'alert-octagon-outline' : 'alert-outline'}
        size={16}
        color={fg}
      />
      <Text style={[styles.alertText, { color: fg }]} numberOfLines={2}>
        {text}
      </Text>
      {more > 0 ? (
        <Text style={[styles.alertMore, { color: fg }]}>{tn('conn.moreAlerts', more)}</Text>
      ) : null}
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  // From / To
  card: { backgroundColor: colors.surface, borderRadius: radius.md, marginTop: space.lg },
  cardWide: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, zIndex: 20 },
  planner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.xs,
    paddingLeft: space.md,
    paddingRight: space.sm,
  },
  plannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
  fieldValueRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
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
  pearlGone: { borderColor: colors.textFaint },
  chainDotsGone: { borderColor: colors.textFaint },
  nowDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.surface,
    marginHorizontal: -7,
    zIndex: 2,
  },

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
  alert: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    marginTop: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
  },
  alertText: { ...type.smallStrong, flex: 1 },
  alertMore: { ...type.small },
}));
