// Journey details: a vertical timeline (time | line track | stop and ride | platform), shared by
// the journey page in the app and the detail pane of the website's split view.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type Journey, type Leg, type Transfer, delayMin, shownTime } from '../api/journeys';
import { colors, modeColors, space, type } from '../theme';
import { formatDuration, formatTime } from '../utils/time';
import { Notice } from './layout';
import { changesLabel, PearlChain } from './planner';
import {
  LinePill,
  MODE_LABEL,
  ModeIcon,
  StatusBadge,
  TimeWithDelay,
  TransferBadge,
  lineColors,
} from './transit';

/** "Parla → Atocha" with times, duration and the pearl chain; heads the website detail pane. */
export function JourneySummary({ journey }: { journey: Journey }) {
  const first = journey.legs[0];
  const last = journey.legs[journey.legs.length - 1];
  return (
    <View style={styles.summary}>
      <Text style={styles.summaryTitle} accessibilityRole="header" numberOfLines={2}>
        {first.from} → {last.to}
      </Text>
      <Text style={styles.small}>
        {formatTime(shownTime(journey.departure))} – {formatTime(shownTime(journey.arrival))} ·{' '}
        {formatDuration(journey.duration_min)} · {changesLabel(journey.transfers)}
      </Text>
      <View style={{ marginTop: space.md }}>
        <PearlChain legs={journey.legs} />
      </View>
    </View>
  );
}

/** Problems first (not possible, cancelled), then operator alerts on the lines used. */
export function JourneyNotices({ journey }: { journey: Journey }) {
  if (journey.feasible && !journey.alerts.length) return null;
  return (
    <View style={{ gap: space.sm, marginTop: space.lg }}>
      {!journey.feasible ? (
        <Notice tone="danger" icon="close-octagon-outline" title="This connection is not possible">
          {journey.issues.join(' ')}
        </Notice>
      ) : null}
      {journey.alerts.slice(0, 3).map((a) => (
        <Notice
          key={`${a.source}:${a.source_alert_id}`}
          tone="warning"
          title={`Service alert · ${a.operator === 'EMT_MADRID' ? 'EMT Madrid' : 'Renfe Cercanías'}`}>
          {a.header ?? a.description ?? 'Service alert'}
        </Notice>
      ))}
    </View>
  );
}

export function JourneyTimeline({ journey }: { journey: Journey }) {
  return (
    <View style={{ paddingVertical: space.sm }}>
      <View style={styles.colHeads}>
        <Text style={[styles.colHead, { width: TIME_W }]}>Time</Text>
        <Text style={[styles.colHead, { flex: 1, marginLeft: TRACK + space.sm }]}>Stop</Text>
        <Text style={[styles.colHead, styles.colHeadRight]}>Platform</Text>
      </View>
      {journey.legs.map((leg, i) => {
        // The change is noted right after the vehicle you get off, before any walk.
        const change = journey.changes.find((c) => c.from_leg === i);
        return (
          <View key={i}>
            {leg.mode === 'walk' ? <WalkLeg leg={leg} /> : <TransitLeg leg={leg} />}
            {change ? <ChangeNote change={change} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function ChangeNote({ change }: { change: Transfer }) {
  return (
    <View style={styles.change} accessibilityLabel={`Change at ${change.at}. ${change.message}`}>
      <MaterialCommunityIcons name="swap-horizontal" size={16} color={colors.textMuted} />
      <View style={styles.changeBody}>
        {change.label ? (
          <TransferBadge label={change.label} />
        ) : (
          <StatusBadge status="frequency" text={`Wait up to ${change.wait_up_to_min} min`} />
        )}
        <Text style={styles.small}>{change.message}</Text>
      </View>
    </View>
  );
}

function WalkLeg({ leg }: { leg: Leg }) {
  return (
    <View style={styles.walk}>
      <View style={styles.timeCol} />
      <View style={styles.track}>
        <View style={styles.walkLine} />
      </View>
      <View style={styles.walkBody}>
        <ModeIcon mode="walk" size={18} />
        <Text style={styles.small}>
          Walk {leg.duration_min} min
          {leg.distance_m ? ` · ${Math.round(leg.distance_m / 10) * 10} m` : ''} to {leg.to}
        </Text>
      </View>
    </View>
  );
}

function Platform({ value }: { value?: string | null }) {
  return (
    <View style={styles.platformCol}>
      {value ? (
        <Text style={styles.platform} accessibilityLabel={`Platform ${value}`}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

function TransitLeg({ leg }: { leg: Leg }) {
  const [open, setOpen] = useState(false);
  const color = leg.line ? lineColors(leg.line).bg : (modeColors[leg.mode]?.bg ?? colors.brand);
  const late = delayMin(leg.departure);
  return (
    <View>
      {/* Boarding stop */}
      <View style={styles.stopRow}>
        <View style={styles.timeCol}>
          <TimeWithDelay time={leg.departure} />
        </View>
        <View style={styles.track}>
          <View style={[styles.lineSeg, { backgroundColor: color, top: 14 }]} />
          <View style={[styles.node, { borderColor: color }]} />
        </View>
        <View style={styles.stopBody}>
          <Text style={styles.stopName}>{leg.from}</Text>
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
          <View style={styles.rideHead}>
            {leg.line ? <LinePill line={leg.line} /> : <ModeIcon mode={leg.mode} />}
            <Text style={styles.rideDir} numberOfLines={2}>
              {MODE_LABEL[leg.mode]} · Direction {leg.headsign ?? leg.to}
            </Text>
          </View>
          <View style={styles.rideBadges}>
            <StatusBadge
              status={leg.departure.status}
              text={
                leg.departure.status === 'frequency' && leg.headway_min
                  ? `Every ~${leg.headway_min} min`
                  : undefined
              }
            />
            {late > 0 ? (
              <Text style={[styles.small, { color: colors.delay }]}>{late} min late</Text>
            ) : null}
          </View>
          {leg.intermediate.length ? (
            <Pressable
              onPress={() => setOpen((o) => !o)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              style={styles.toggle}>
              <Text style={styles.toggleText}>
                {leg.intermediate.length} stop{leg.intermediate.length > 1 ? 's' : ''} ·{' '}
                {formatDuration(leg.duration_min)}
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
          {open
            ? leg.intermediate.map((s, k) => (
                <View key={`${k}:${s.name}`} style={styles.inter}>
                  <Text style={styles.interTime}>{formatTime(s.time)}</Text>
                  <Text style={styles.small}>{s.name}</Text>
                </View>
              ))
            : null}
        </View>
      </View>

      {/* Alighting stop */}
      <View style={styles.stopRow}>
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
    </View>
  );
}

const TIME_W = 64;
const TRACK = 24;
const styles = StyleSheet.create({
  summary: { padding: space.lg, gap: 2 },
  summaryTitle: { ...type.heading, fontSize: 20, color: colors.text },
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
  rideBadges: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  toggleText: { ...type.smallStrong, color: colors.brand },
  inter: { flexDirection: 'row', gap: space.sm },
  interTime: { ...type.small, color: colors.textMuted, width: 44, fontVariant: ['tabular-nums'] },
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
});
