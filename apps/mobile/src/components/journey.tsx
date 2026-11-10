// Journey details: a vertical timeline (time | line track | stop and ride | platform), shared by
// the journey page in the app and the detail pane of the website's split view.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  type LayoutChangeEvent,
  Pressable,
  Platform as RNPlatform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { type Journey, type Leg, type Transfer, delayMin } from '../api/journeys';
import { byAlertSeverity, isSevereAlert } from '../api/stops';
import { useNow, useReduceMotion, useTrainPosition } from '../hooks';
import { useT } from '../i18n';
import { colors, modeColors, space, themed, type } from '../theme';
import { formatDuration, formatTime } from '../utils/time';
import {
  type Placement,
  sourceText,
  approachText,
  place,
  positionAgeS,
  ridingText,
  trackY,
} from '../utils/trainPosition';
import { Notice } from './layout';
import {
  LinePill,
  ModeIcon,
  StatusBadge,
  TimeWithDelay,
  TransferBadge,
  lineColors,
  modeLabel,
} from './transit';

/** Problems first (not possible, cancelled), then operator alerts on the lines used. */
export function JourneyNotices({ journey }: { journey: Journey }) {
  const { t } = useT();
  if (journey.feasible && !journey.alerts.length) return null;
  return (
    <View style={{ gap: space.sm, marginTop: space.lg }}>
      {!journey.feasible ? (
        <Notice tone="danger" icon="close-octagon-outline" title={t('journey.notPossible')}>
          {journey.issues.join(' ')}
        </Notice>
      ) : null}
      {byAlertSeverity(journey.alerts)
        .slice(0, 3)
        .map((a) => (
          <Notice
            key={`${a.source}:${a.source_alert_id}`}
            tone={isSevereAlert(a) ? 'danger' : 'warning'}
            icon={isSevereAlert(a) ? 'alert-octagon-outline' : undefined}
            title={t('journey.alert', {
              operator: a.operator === 'EMT_MADRID' ? 'EMT Madrid' : 'Renfe Cercanías',
            })}>
            {a.header ?? a.description ?? t('journey.alertFallback')}
          </Notice>
        ))}
    </View>
  );
}

export function JourneyTimeline({ journey }: { journey: Journey }) {
  const { t } = useT();
  return (
    <View style={{ paddingVertical: space.sm }}>
      <View style={styles.colHeads}>
        <Text style={[styles.colHead, { width: TIME_W }]}>{t('journey.colTime')}</Text>
        <Text style={[styles.colHead, { flex: 1, marginLeft: TRACK + space.sm }]}>
          {t('journey.colStop')}
        </Text>
        <Text style={[styles.colHead, styles.colHeadRight]}>{t('journey.colPlatform')}</Text>
      </View>
      {journey.legs.map((leg, i) => {
        // The change is noted right after the vehicle you get off, before any walk.
        const change = journey.changes.find((c) => c.from_leg === i);
        return (
          <View key={i}>
            {leg.mode === 'walk' ? (
              <WalkLeg leg={leg} />
            ) : (
              <TransitLeg leg={leg} journeyId={journey.id} legIndex={i} />
            )}
            {change ? <ChangeNote change={change} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function ChangeNote({ change }: { change: Transfer }) {
  const { t } = useT();
  return (
    <View
      style={styles.change}
      accessibilityLabel={t('journey.changeAt', { stop: change.at, message: change.message })}>
      <MaterialCommunityIcons name="swap-horizontal" size={16} color={colors.textMuted} />
      <View style={styles.changeBody}>
        {change.label ? (
          <TransferBadge label={change.label} />
        ) : (
          <StatusBadge
            status="frequency"
            text={t('journey.waitUpTo', { n: change.wait_up_to_min ?? '?' })}
          />
        )}
        <Text style={styles.small}>{change.message}</Text>
      </View>
    </View>
  );
}

function WalkLeg({ leg }: { leg: Leg }) {
  const { t } = useT();
  return (
    <View style={styles.walk}>
      <View style={styles.timeCol} />
      <View style={styles.track}>
        <View style={styles.walkLine} />
      </View>
      <View style={styles.walkBody}>
        <ModeIcon mode="walk" size={18} />
        <Text style={styles.small}>
          {t('journey.walk', {
            min: leg.duration_min,
            distance: leg.distance_m ? ` · ${Math.round(leg.distance_m / 10) * 10} m` : '',
            stop: leg.to,
          })}
        </Text>
      </View>
    </View>
  );
}

function Platform({ value }: { value?: string | null }) {
  const { t } = useT();
  return (
    <View style={styles.platformCol}>
      {value ? (
        <Text style={styles.platform} accessibilityLabel={t('journey.platform', { p: value })}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

/** Opens the trip screen: the whole route of this leg's vehicle, with its position. */
export function openTrip(journeyId: string, legIndex: number) {
  router.push({ pathname: '/trip', params: { journey: journeyId, leg: String(legIndex) } });
}

function TransitLeg({
  leg,
  journeyId,
  legIndex,
}: {
  leg: Leg;
  journeyId: string;
  legIndex: number;
}) {
  const { t, tn } = useT();
  const [open, setOpen] = useState(false);
  const color = leg.line ? lineColors(leg.line).bg : (modeColors[leg.mode]?.bg ?? colors.brand);
  const late = delayMin(leg.departure);

  // Live train position (Cercanías only; see utils/trainPosition.ts for the rules).
  const pos = useTrainPosition(leg);
  const now = useNow(pos ? 1000 : 60_000);
  const placement: Placement = pos ? place(pos, leg, now) : { kind: 'none' };
  const age = pos ? positionAgeS(pos, now) : null;
  const riding = placement.kind === 'riding';
  // Riding: open the stops once, so the point has stations to move between.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (riding && !autoOpened.current && leg.intermediate.length) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [riding, leg.intermediate.length]);

  // Centre of each stop marker, measured, for rows 0 (boarding) .. n+1 (alighting); for the
  // approach row, its top.
  const [ys, setYs] = useState<Record<string, number>>({});
  const measure = (key: string, centre: number) => (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    const value = y + (centre < 0 ? height / 2 : centre);
    setYs((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  };
  const rowCount = leg.intermediate.length + 2;
  let dotY: number | null = null;
  if (placement.kind === 'approaching' && ys.approach != null && ys['0'] != null) {
    // From the top of the approach line down to the boarding stop.
    const top = ys.approach + DOT / 2 + 4;
    dotY = top + (ys['0'] - top) * placement.progress;
  }
  if (placement.kind === 'riding') {
    const rowYs = Array.from({ length: rowCount }, (_, r) =>
      r === 0 || r === rowCount - 1 || open ? ys[String(r)] : undefined,
    );
    dotY = trackY(rowYs, placement.row, placement.progress);
  }
  // A stop the train has already left (riding only): drawn faded.
  const passed = (r: number) =>
    placement.kind === 'riding' && (r < placement.row || (r === placement.row && !placement.at));

  return (
    <View>
      {placement.kind === 'approaching' ? (
        <View style={styles.approach} onLayout={measure('approach', 0)}>
          <View style={styles.timeCol} />
          <View style={styles.track}>
            <View style={[styles.lineSeg, styles.lineAhead, { backgroundColor: color, top: 0 }]} />
          </View>
          <View style={styles.approachBody}>
            <Text style={styles.liveStrong}>{approachText(placement)}</Text>
            {pos ? <Text style={styles.small}>{sourceText(pos, age)}</Text> : null}
          </View>
        </View>
      ) : null}

      {/* Boarding stop */}
      <View style={styles.stopRow} onLayout={measure('0', NODE_CENTRE)}>
        <View style={styles.timeCol}>
          <TimeWithDelay time={leg.departure} />
        </View>
        <View style={styles.track}>
          {placement.kind === 'approaching' ? (
            <View
              style={[
                styles.lineSeg,
                styles.lineAhead,
                { backgroundColor: color, top: 0, height: 14 },
              ]}
            />
          ) : null}
          <View style={[styles.lineSeg, { backgroundColor: color, top: 14 }]} />
          <View style={[styles.node, { borderColor: color }]} />
        </View>
        <View style={styles.stopBody}>
          <Text style={[styles.stopName, passed(0) && styles.passedText]}>{leg.from}</Text>
        </View>
        <Platform value={leg.departure.platform} />
      </View>

      {/* The ride */}
      <View style={styles.ride}>
        <View style={styles.timeCol} />
        <View style={styles.track}>
          <View style={[styles.lineSeg, { backgroundColor: color, top: 0, bottom: 0 }]} />
        </View>
        <View style={styles.rideBody}>
          <Pressable
            onPress={leg.trip_id ? () => openTrip(journeyId, legIndex) : undefined}
            disabled={!leg.trip_id}
            accessibilityRole={leg.trip_id ? 'button' : undefined}
            accessibilityHint={leg.trip_id ? t('journey.showStops') : undefined}
            style={({ pressed }) => [styles.rideHead, pressed && styles.pressed]}>
            {leg.line ? <LinePill line={leg.line} /> : <ModeIcon mode={leg.mode} />}
            <Text style={styles.rideDir} numberOfLines={3}>
              {modeLabel(leg.mode)}
              {/* Never the passenger's destination: that may not be where the train ends. */}
              {leg.headsign ? ` · ${t('conn.direction', { name: leg.headsign })}` : ''}
            </Text>
            {leg.trip_id ? (
              <MaterialCommunityIcons name="chevron-right" size={22} color={colors.brand} />
            ) : null}
          </Pressable>
          <View style={styles.rideBadges}>
            <StatusBadge
              status={leg.departure.status}
              text={
                leg.departure.status === 'frequency' && leg.headway_min
                  ? t('status.everyN', { n: leg.headway_min })
                  : undefined
              }
            />
            {late > 0 ? (
              <Text style={[styles.small, { color: colors.delay }]}>
                {t('journey.late', { n: late })}
              </Text>
            ) : null}
          </View>
          {riding && pos ? (
            <Text style={styles.small}>
              <Text style={styles.liveStrong}>{ridingText(pos, placement.at)}</Text>
              {` · ${sourceText(pos, age)}`}
            </Text>
          ) : null}
          {leg.intermediate.length ? (
            <Pressable
              onPress={() => setOpen((o) => !o)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              style={styles.toggle}>
              <Text style={styles.toggleText}>
                {tn('journey.stops', leg.intermediate.length)} · {formatDuration(leg.duration_min)}
              </Text>
              <MaterialCommunityIcons
                name={open ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.brand}
              />
            </Pressable>
          ) : (
            <Text style={styles.small}>{formatDuration(leg.duration_min)}</Text>
          )}
        </View>
      </View>

      {/* Intermediate stops, on the line */}
      {open
        ? leg.intermediate.map((s, k) => (
            <View
              key={`${k}:${s.name}`}
              style={styles.interRow}
              onLayout={measure(String(k + 1), INTER_NODE_CENTRE)}>
              <View style={styles.timeCol}>
                <Text style={[styles.interTime, passed(k + 1) && styles.passedText]}>
                  {formatTime(s.time)}
                </Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.lineSeg, { backgroundColor: color, top: 0, bottom: 0 }]} />
                <View style={[styles.interNode, { borderColor: color }]} />
              </View>
              <View style={styles.interBody}>
                <Text style={[styles.interName, passed(k + 1) && styles.passedText]}>{s.name}</Text>
              </View>
            </View>
          ))
        : null}

      {/* Alighting stop */}
      <View style={styles.stopRow} onLayout={measure(String(rowCount - 1), NODE_CENTRE)}>
        <View style={styles.timeCol}>
          <TimeWithDelay time={leg.arrival} />
        </View>
        <View style={styles.track}>
          <View style={[styles.lineSeg, { backgroundColor: color, top: 0, height: 8 }]} />
          <View style={[styles.node, { borderColor: color }]} />
        </View>
        <View style={styles.stopBody}>
          <Text style={styles.stopName}>{leg.to}</Text>
        </View>
        <Platform value={leg.arrival.platform} />
      </View>

      {dotY != null ? <TrainDot y={dotY} estimated={pos?.kind === 'estimated'} /> : null}
    </View>
  );
}

/**
 * The moving point on the line. Each new target is reached in a 1 s linear move, so the
 * once-a-second targets while riding read as continuous movement, and a new GPS fix is a
 * short glide. With "reduce motion" on, it jumps.
 */
export function TrainDot({ y, estimated }: { y: number; estimated: boolean }) {
  const reduce = useReduceMotion();
  const [anim] = useState(() => new Animated.Value(y));
  useEffect(() => {
    if (reduce) {
      anim.setValue(y);
      return;
    }
    const a = Animated.timing(anim, {
      toValue: y,
      duration: 1000,
      easing: Easing.linear,
      useNativeDriver: RNPlatform.OS !== 'web',
    });
    a.start();
    return () => a.stop();
  }, [y, reduce, anim]);
  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        styles.dot,
        estimated && styles.dotEstimated,
        { transform: [{ translateY: Animated.subtract(anim, DOT / 2) }] },
      ]}
    />
  );
}

const TIME_W = 64;
const TRACK = 24;
const NODE_CENTRE = 15; // marginTop 8 + half of 14
const INTER_NODE_CENTRE = 12; // marginTop 7 + half of 10
const DOT = 18;
const styles = themed(() => StyleSheet.create({
  colHeads: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
  colHead: { ...type.label, fontSize: 11, color: colors.textFaint },
  colHeadRight: { width: 64, textAlign: 'right' },
  platformCol: { width: 64, alignItems: 'flex-end', textAlign: 'right', paddingTop: 4 },
  platform: { ...type.timeL, fontSize: 16, color: colors.text },
  stopRow: { flexDirection: 'row', paddingHorizontal: space.lg, minHeight: 44 },
  timeCol: { width: TIME_W, paddingTop: 4 },
  track: { width: TRACK, alignItems: 'center' },
  node: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 3,
    backgroundColor: colors.surface,
    marginTop: 8,
    zIndex: 1,
  },
  lineSeg: { position: 'absolute', width: 5, bottom: 0 },
  stopBody: { flex: 1, paddingLeft: space.sm, paddingTop: 4, paddingBottom: space.sm },
  stopName: { ...type.bodyStrong, color: colors.text },
  ride: { flexDirection: 'row', paddingHorizontal: space.lg },
  rideBody: { flex: 1, paddingLeft: space.sm, paddingVertical: space.sm, gap: 6 },
  rideHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rideDir: { ...type.body, color: colors.text, flex: 1 },
  pressed: { opacity: 0.6 },
  rideBadges: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  toggleText: { ...type.smallStrong, color: colors.brand },
  interRow: { flexDirection: 'row', paddingHorizontal: space.lg, minHeight: 30 },
  interNode: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    backgroundColor: colors.surface,
    marginTop: 7,
    zIndex: 1,
  },
  interTime: {
    ...type.small,
    color: colors.textMuted,
    paddingTop: 3,
    fontVariant: ['tabular-nums'],
  },
  interBody: { flex: 1, paddingLeft: space.sm, paddingTop: 3, paddingBottom: space.xs },
  interName: { ...type.small, color: colors.text },
  passedText: { color: colors.textFaint },
  lineAhead: { opacity: 0.35 },
  approach: { flexDirection: 'row', paddingHorizontal: space.lg, minHeight: 44 },
  approachBody: { flex: 1, paddingLeft: space.sm, paddingVertical: space.sm, gap: 2 },
  liveStrong: { ...type.smallStrong, color: colors.live },
  dot: {
    position: 'absolute',
    top: 0,
    left: space.lg + TIME_W + TRACK / 2 - DOT / 2,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: colors.surface,
    zIndex: 2,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  // Estimated (timetable) position: hollow, so it is never mistaken for a live one.
  dotEstimated: { backgroundColor: colors.surface, borderColor: colors.accent, borderWidth: 4 },
  small: { ...type.small, color: colors.textMuted },
  walk: { flexDirection: 'row', paddingHorizontal: space.lg, minHeight: 40 },
  walkLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 0,
    borderLeftWidth: 3,
    borderStyle: 'dotted',
    borderColor: modeColors.walk.bg,
  },
  walkBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.sm,
  },
  changeBody: { flex: 1, gap: 4 },
  change: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingRight: space.lg,
    gap: space.sm,
    marginLeft: space.lg + TIME_W + TRACK + space.sm,
    paddingVertical: space.sm,
  },
}));
