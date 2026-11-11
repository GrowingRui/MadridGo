// The Trips tab, as in SBB Mobile ("Single trips"): the connections saved with ☆, grouped by
// day, each with its state ("in 12 min", "On the way · arrives 14:51"), lines and progress.
// A trip disappears once it has arrived. Without trips: "No journeys saved" and a button to
// plan one.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type Journey, shownTime } from '../api/journeys';
import type { Line } from '../api/stops';
import { type PressState, useNow } from '../hooks';
import { useT } from '../i18n';
import {
  expectedMs,
  removeConnection,
  type SavedConnection,
  tripPhase,
} from '../state/connections';
import { journeyCache } from '../state/journeys';
import { colors, radius, space, themed, type } from '../theme';
import { followedLeg } from '../utils/liveMap';
import { dayLabel, formatTime, madridDayStart, minutesUntil } from '../utils/time';
import { ConnectionHeader } from './connection';
import { Button, SectionTitle } from './layout';
import { LinePills, StatusBadge } from './transit';

/** Each line once, in riding order. */
function tripLines(journey: Journey): Line[] {
  const seen = new Set<string>();
  const lines: Line[] = [];
  for (const leg of journey.legs) {
    if (!leg.line) continue;
    const key = `${leg.line.source}:${leg.line.route_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      lines.push(leg.line);
    }
  }
  return lines;
}

/** Saved trips grouped by the day they leave: [["Today", [...]], ["Tomorrow", [...]]]. */
export function groupByDay(trips: SavedConnection[], now: number): [string, SavedConnection[]][] {
  const groups = new Map<number, SavedConnection[]>();
  for (const c of trips) {
    const day = madridDayStart(Date.parse(shownTime(c.journey.departure)));
    groups.set(day, [...(groups.get(day) ?? []), c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, list]) => [dayLabel(day, now), list]);
}

export function TripList({ trips }: { trips: SavedConnection[] }) {
  const now = useNow(15_000);
  return (
    <View style={styles.list}>
      {groupByDay(trips, now).map(([day, list]) => (
        <View key={day} style={styles.group}>
          <SectionTitle>{day}</SectionTitle>
          {list.map((c) => (
            <TripCard key={c.journey.id} trip={c} now={now} />
          ))}
        </View>
      ))}
    </View>
  );
}

function TripState({ journey, now }: { journey: Journey; now: number }) {
  const { t } = useT();
  const live = journey.legs.some(
    (l) => l.departure.status === 'live' || l.arrival.status === 'live',
  );
  const cancelled = journey.legs.some(
    (l) => l.departure.status === 'cancelled' || l.arrival.status === 'cancelled',
  );
  let text: string;
  if (tripPhase(journey, now) === 'ongoing') {
    text = t('trips.onTheWay', { time: formatTime(expectedMs(journey.arrival)) });
  } else {
    const min = minutesUntil(new Date(expectedMs(journey.departure)).toISOString(), now);
    text =
      min <= 0
        ? t('trips.leavingNow')
        : min < 60
          ? t('trips.leavesIn', { n: min })
          : t('trips.leavesAt', { time: formatTime(expectedMs(journey.departure)) });
  }
  return (
    <View style={styles.stateRow}>
      <Text style={styles.stateText}>{text}</Text>
      <StatusBadge status={cancelled ? 'cancelled' : live ? 'live' : 'scheduled'} />
    </View>
  );
}

function TripCard({ trip, now }: { trip: SavedConnection; now: number }) {
  const { t } = useT();
  const j = trip.journey;
  const open = () => {
    journeyCache.set(j.id, j);
    router.push({ pathname: '/journey/[id]', params: { id: j.id } });
  };
  const ongoing = tripPhase(j, now) === 'ongoing';
  // As in SBB Mobile: a "Live" map while a Cercanías ride is on or coming up (90 min before).
  const liveMap = followedLeg(j, now) != null;
  const openMap = () => {
    journeyCache.set(j.id, j);
    router.push({ pathname: '/route-map', params: { id: j.id } });
  };
  return (
    <View style={[styles.card, ongoing && styles.cardOngoing]}>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityHint={t('trips.openHint')}
        style={({ pressed, hovered }: PressState) => [
          styles.cardPress,
          (pressed || hovered) && { backgroundColor: colors.pressed },
        ]}>
        <View style={styles.cardTop}>
          <TripState journey={j} now={now} />
          <LinePills lines={tripLines(j)} max={5} />
        </View>
        <ConnectionHeader journey={j} />
      </Pressable>
      {liveMap ? (
        <Pressable
          onPress={openMap}
          accessibilityRole="button"
          accessibilityHint={t('liveMap.openHint')}
          style={({ pressed, hovered }: PressState) => [
            styles.liveMap,
            (pressed || hovered) && { backgroundColor: colors.pressed },
          ]}>
          <MaterialCommunityIcons name="map-marker-radius" size={20} color={colors.brand} />
          <Text style={styles.liveMapText}>{t('liveMap.open')}</Text>
          <MaterialCommunityIcons
            name="chevron-right"
            size={20}
            color={colors.textMuted}
            style={{ marginLeft: 'auto' }}
          />
        </Pressable>
      ) : null}
      <Pressable
        onPress={() => removeConnection(j.id)}
        accessibilityRole="button"
        accessibilityLabel={t('trips.remove')}
        hitSlop={8}
        style={({ pressed, hovered }: PressState) => [
          styles.remove,
          (pressed || hovered) && { backgroundColor: colors.pressed },
        ]}>
        <MaterialCommunityIcons name="star" size={24} color={colors.brand} />
      </Pressable>
    </View>
  );
}

/** As in SBB Mobile: a card saying there are no trips, and a button to plan one. */
export function NoTrips() {
  const { t } = useT();
  return (
    <View style={styles.empty}>
      <View style={styles.emptyCard}>
        <View style={styles.emptyIcon}>
          <MaterialCommunityIcons name="train" size={40} color={colors.brand} />
        </View>
        <Text style={styles.emptyTitle} accessibilityRole="header">
          {t('trips.emptyTitle')}
        </Text>
        <Text style={styles.emptyText}>{t('trips.emptyBody')}</Text>
      </View>
      <Button label={t('trips.plan')} icon="magnify" onPress={() => router.navigate('/')} />
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    list: { gap: space.lg },
    group: { gap: space.sm },
    card: {
      marginHorizontal: space.lg,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    cardOngoing: { borderColor: colors.accent, borderWidth: 2 },
    cardPress: { paddingTop: space.md },
    cardTop: {
      paddingHorizontal: space.lg,
      paddingRight: 56, // room for the star
      gap: space.sm,
    },
    stateRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
    stateText: { ...type.bodyStrong, color: colors.text },
    liveMap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      minHeight: 48,
      paddingHorizontal: space.lg,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    liveMapText: { ...type.bodyStrong, color: colors.brand },
    remove: {
      position: 'absolute',
      top: space.sm,
      right: space.sm,
      width: 44,
      height: 44,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    empty: { marginHorizontal: space.lg, marginTop: space.lg, gap: space.xl },
    emptyCard: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: space.xl,
      alignItems: 'center',
      gap: space.md,
    },
    emptyIcon: {
      width: 72,
      height: 72,
      borderRadius: radius.pill,
      backgroundColor: colors.bg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyTitle: { ...type.heading, color: colors.text, textAlign: 'center' },
    emptyText: { ...type.body, color: colors.textMuted, textAlign: 'center' },
  }),
);
