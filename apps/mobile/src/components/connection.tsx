// The connection header, as in SBB Mobile: a card with "From → To", the day and travel time,
// and the departure and arrival times around the connection's line; under it round buttons
// to save the connection (☆) and to see its route on a map. Also the Plan screen's list of
// saved connections.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { type Journey, shownTime } from '../api/journeys';
import { type PressState, useNow } from '../hooks';
import { useT } from '../i18n';
import {
  isConnectionSaved,
  type SavedConnection,
  toggleConnection,
  useSavedConnections,
} from '../state/connections';
import { journeyCache } from '../state/journeys';
import type { Place } from '../state/planner';
import { colors, radius, space, themed, type } from '../theme';
import { addConnectionToCalendar, shareConnection, type ShareResult } from '../utils/shareActions';
import { dayLabel, formatDuration, formatTime } from '../utils/time';
import { Card, SectionTitle } from './layout';
import { PearlChain } from './planner';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

/** "Parla → Madrid - Atocha", "Today, 1 h 29 min", and 22:19 ●━━━○━━━● 23:48. */
export function ConnectionHeader({ journey }: { journey: Journey }) {
  const { t } = useT();
  const now = useNow(15_000);
  const first = journey.legs[0];
  const last = journey.legs[journey.legs.length - 1];
  const dep = shownTime(journey.departure);
  const arr = shownTime(journey.arrival);
  return (
    <View style={styles.header}>
      <Text style={styles.title} accessibilityRole="header" numberOfLines={3}>
        {first.from} → {last.to}
      </Text>
      <Text style={styles.summary}>
        {t('conn.summary', {
          day: dayLabel(Date.parse(dep), now),
          duration: formatDuration(journey.duration_min),
        })}
      </Text>
      <View style={styles.timesRow}>
        <Text style={styles.time}>{formatTime(dep)}</Text>
        <View style={{ flex: 1 }}>
          <PearlChain legs={journey.legs} now={now} />
        </View>
        <Text style={styles.time}>{formatTime(arr)}</Text>
      </View>
    </View>
  );
}

/** The round buttons under the header: save (☆ / ★) and route map. */
export function ConnectionActions({
  journey,
  from,
  to,
}: {
  journey: Journey;
  /** What was planned; without it the connection cannot be saved (it could not be refreshed). */
  from: Place | null;
  to: Place | null;
}) {
  const { t } = useT();
  const saved = isConnectionSaved(journey.id, useSavedConnections());
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [message]);
  const run = (action: (j: Journey) => Promise<ShareResult>) => {
    action(journey)
      .then((r) =>
        setMessage(
          r === 'copied' ? t('share.copied') : r === 'downloaded' ? t('share.downloaded') : null,
        ),
      )
      .catch(() => setMessage(t('share.failed')));
  };
  return (
    <View>
      <View style={styles.actions}>
        {from && to ? (
          <RoundButton
            icon={saved ? 'star' : 'star-outline'}
            label={t(saved ? 'conn.unsave' : 'conn.save')}
            selected={saved}
            onPress={() => toggleConnection(journey, from, to)}
          />
        ) : null}
        <RoundButton
          icon="map-outline"
          label={t('conn.map')}
          onPress={() => {
            journeyCache.set(journey.id, journey);
            router.push({ pathname: '/route-map', params: { id: journey.id } });
          }}
        />
        <RoundButton
          icon={Platform.OS === 'ios' ? 'export-variant' : 'share-variant'}
          label={t('share.share')}
          onPress={() => run(shareConnection)}
        />
        <RoundButton
          icon="calendar-plus"
          label={t('share.calendar')}
          onPress={() => run(addConnectionToCalendar)}
        />
      </View>
      {message ? (
        <Text style={styles.message} accessibilityLiveRegion="polite" role="status">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

function RoundButton({
  icon,
  label,
  selected,
  onPress,
}: {
  icon: IconName;
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected != null ? { selected } : undefined}
      style={({ pressed, hovered }: PressState) => [
        styles.round,
        (pressed || hovered) && { backgroundColor: colors.pressed },
      ]}>
      <MaterialCommunityIcons name={icon} size={26} color={colors.brand} />
    </Pressable>
  );
}

/** Plan screen, before a search: saved connections still ahead, earliest first. */
export function SavedConnections() {
  const { t } = useT();
  const saved = useSavedConnections();
  if (!saved.length) return null;
  const open = (c: SavedConnection) => {
    journeyCache.set(c.journey.id, c.journey);
    router.push({ pathname: '/journey/[id]', params: { id: c.journey.id } });
  };
  return (
    <View style={styles.savedWrap}>
      <SectionTitle>{t('conn.saved')}</SectionTitle>
      {saved.map((c) => (
        <Pressable
          key={c.journey.id}
          onPress={() => open(c)}
          accessibilityRole="button"
          style={({ pressed, hovered }: PressState) => [
            styles.savedCard,
            (pressed || hovered) && { backgroundColor: colors.pressed },
          ]}>
          <ConnectionHeader journey={c.journey} />
        </Pressable>
      ))}
    </View>
  );
}

/** The card style for the header, also used by the journey screen. */
export function ConnectionCard({ children }: { children: React.ReactNode }) {
  return <Card style={styles.card}>{children}</Card>;
}

const styles = themed(() =>
  StyleSheet.create({
    card: { marginHorizontal: space.lg },
    header: { padding: space.lg, gap: 4 },
    title: { ...type.heading, fontSize: 20, color: colors.text },
    summary: { ...type.body, color: colors.textMuted },
    timesRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm },
    time: { ...type.timeL, color: colors.text },
    actions: {
      flexDirection: 'row',
      gap: space.md,
      marginHorizontal: space.lg + space.md,
      marginTop: space.md,
    },
    message: {
      ...type.body,
      color: colors.textMuted,
      marginHorizontal: space.lg + space.md,
      marginTop: space.sm,
    },
    round: {
      width: 52,
      height: 52,
      borderRadius: radius.pill,
      borderWidth: 1.5,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    savedWrap: { gap: space.sm },
    savedCard: {
      marginHorizontal: space.lg,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
    },
  }),
);
