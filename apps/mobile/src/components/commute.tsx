// Saved routes (commutes) in the Trips tab: for each route you travel often, the next three
// departures with their live status, refreshed every minute while the tab is in front. A tap
// opens the connection; "More connections" opens the full search; the arrows swap the
// direction (home -> work, work -> home). Routes are saved from the Connections screen
// (SaveRouteButton).

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { planJourneys } from '../api/journeys';
import { type PressState, useAsync, useNow } from '../hooks';
import { useT } from '../i18n';
import {
  type Commute,
  addCommute,
  canSaveRoute,
  isRouteSaved,
  removeCommute,
  swapCommute,
  useCommutes,
} from '../state/commutes';
import { journeyCache } from '../state/journeys';
import { copySavedAt, planAsTimetable, withOfflineCopy } from '../state/offlineCopies';
import { type Place, planPlace, startSearch } from '../state/planner';
import { colors, radius, space, themed, type } from '../theme';
import { Divider, SectionTitle } from './layout';
import { OfflineLine } from './offline';
import { ConnectionCard } from './planner';

/** Departures shown per route. */
export const SHOWN = 3;
const REFRESH_MS = 60_000;

export function CommuteSection({ active }: { active: boolean }) {
  const { t } = useT();
  const { commutes } = useCommutes();
  if (!commutes.length) return null;
  return (
    <View style={styles.section}>
      <SectionTitle>{t('commute.title')}</SectionTitle>
      {commutes.map((c) => (
        <CommuteCard key={c.id} commute={c} active={active} />
      ))}
    </View>
  );
}

function CommuteCard({ commute, active }: { commute: Commute; active: boolean }) {
  const { t } = useT();
  const now = useNow(REFRESH_MS);
  const plan = useAsync(
    () =>
      withOfflineCopy(
        `commute:${commute.id}`,
        () => planJourneys({ from: planPlace(commute.from), to: planPlace(commute.to), at: null }),
        planAsTimetable,
      ),
    commute.id,
  );
  const savedAt = copySavedAt(plan.data);
  // Asks again when the tab comes to the front and every minute while it is (not on mount:
  // useAsync has just asked).
  const { reload } = plan;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) mounted.current = true;
    else if (active) reload();
  }, [active, now, reload]);
  const journeys = plan.data?.journeys.slice(0, SHOWN) ?? [];

  const open = (id: string) => {
    plan.data?.journeys.forEach((j) => journeyCache.set(j.id, j));
    router.push({ pathname: '/journey/[id]', params: { id } });
  };
  const more = () => {
    startSearch({ from: commute.from, to: commute.to });
    router.navigate('/');
  };

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.names}>
          <Text style={styles.name} numberOfLines={1}>
            {commute.from.name}
          </Text>
          <MaterialCommunityIcons name="arrow-right" size={18} color={colors.textMuted} />
          <Text style={styles.name} numberOfLines={1}>
            {commute.to.name}
          </Text>
        </View>
        <IconButton
          icon="swap-horizontal"
          label={t('commute.swap')}
          onPress={() => swapCommute(commute.id)}
        />
        <IconButton
          icon="close"
          label={t('commute.remove')}
          onPress={() => removeCommute(commute.id)}
        />
      </View>
      {savedAt ? (
        <>
          <Divider />
          <OfflineLine savedAt={savedAt} />
        </>
      ) : null}
      {journeys.length ? (
        journeys.map((j) => (
          <View key={j.id}>
            <Divider />
            <ConnectionCard journey={j} now={now} onPress={() => open(j.id)} />
          </View>
        ))
      ) : (
        <>
          <Divider />
          <Text style={styles.note} accessibilityLiveRegion="polite">
            {plan.data
              ? (plan.data.message ?? t('commute.none'))
              : plan.error
                ? plan.error
                : t('commute.loading')}
          </Text>
        </>
      )}
      <Divider />
      <Pressable
        onPress={more}
        accessibilityRole="button"
        style={({ pressed, hovered }: PressState) => [
          styles.more,
          (pressed || hovered) && { backgroundColor: colors.pressed },
        ]}>
        <Text style={styles.moreText}>{t('commute.more')}</Text>
        <MaterialCommunityIcons name="chevron-right" size={20} color={colors.brand} />
      </Pressable>
    </View>
  );
}

function IconButton({
  icon,
  label,
  onPress,
}: {
  icon: 'swap-horizontal' | 'close';
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed, hovered }: PressState) => [
        styles.iconButton,
        (pressed || hovered) && { backgroundColor: colors.pressed },
      ]}>
      <MaterialCommunityIcons name={icon} size={22} color={colors.brand} />
    </Pressable>
  );
}

/** On the Connections screen: keeps this From and To as a route in the Trips tab. */
export function SaveRouteButton({ from, to }: { from: Place | null; to: Place | null }) {
  const { t } = useT();
  const { commutes } = useCommutes();
  if (!from || !to || !canSaveRoute(from, to)) return null;
  const saved = isRouteSaved(from, to, commutes);
  const press = () => {
    if (saved) router.navigate('/trips');
    else addCommute(from, to);
  };
  return (
    <Pressable
      onPress={press}
      accessibilityRole="button"
      accessibilityLabel={saved ? t('commute.savedGo') : t('commute.save')}
      style={({ pressed, hovered }: PressState) => [
        styles.save,
        (pressed || hovered) && { backgroundColor: colors.pressed },
      ]}>
      <MaterialCommunityIcons
        name={saved ? 'bookmark-check' : 'bookmark-plus-outline'}
        size={20}
        color={colors.brand}
      />
      <Text style={styles.saveText}>{saved ? t('commute.savedGo') : t('commute.save')}</Text>
    </Pressable>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    section: { gap: space.sm, marginBottom: space.lg },
    card: {
      marginHorizontal: space.lg,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      paddingLeft: space.lg,
      paddingRight: space.sm,
      paddingVertical: space.xs,
    },
    names: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.xs },
    name: { ...type.bodyStrong, color: colors.text, flexShrink: 1 },
    iconButton: {
      width: 44,
      height: 44,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    note: { ...type.body, color: colors.textMuted, padding: space.lg },
    more: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 48,
      paddingHorizontal: space.lg,
    },
    moreText: { ...type.bodyStrong, color: colors.brand },
    save: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: space.xs,
      minHeight: 44,
      marginHorizontal: space.lg,
      marginTop: space.sm,
      paddingHorizontal: space.md,
      borderRadius: radius.pill,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    saveText: { ...type.bodyStrong, color: colors.brand },
  }),
);
