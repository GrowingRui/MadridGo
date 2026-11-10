// Departures tab: pick a stop to see its board. Same list as the planner's search: "Current
// location" (shows the stops near you), starred stops, then recent ones.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { BrandHeader, Screen } from '../../components/layout';
import { NearbyStops, StopSuggestions } from '../../components/stopSearch';
import { useT } from '../../i18n';
import { type SavedStop, addRecent, clearRecents, useSaved } from '../../state/saved';
import { colors, radius, space, type } from '../../theme';
import type { Point } from '../../utils/location';

export default function DeparturesScreen() {
  const saved = useSaved();
  const { t } = useT();
  const [near, setNear] = useState<Point | null>(null);
  const open = (s: SavedStop) => {
    addRecent(s);
    router.push({ pathname: '/stop/[id]', params: { id: s.id } });
  };
  return (
    <Screen
      header={
        <BrandHeader title={t('dep.title')} subtitle={t('dep.subtitle')}>
          <Pressable
            onPress={() => router.push({ pathname: '/pick', params: { field: 'board' } })}
            accessibilityRole="search"
            style={styles.fakeSearch}>
            <MaterialCommunityIcons name="magnify" size={22} color={colors.textMuted} />
            <Text style={styles.fakeSearchText}>{t('search.placeholder')}</Text>
          </Pressable>
        </BrandHeader>
      }>
      {near ? (
        <NearbyStops point={near} onPick={open} onHere={setNear} />
      ) : (
        <>
          <StopSuggestions text="" onPick={open} onHere={setNear} />
          {saved.recents.length ? (
            <Text onPress={clearRecents} style={styles.clear} accessibilityRole="button">
              {t('search.clearRecents')}
            </Text>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fakeSearch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    marginTop: space.lg,
  },
  fakeSearchText: { ...type.body, color: colors.textFaint },
  clear: {
    ...type.smallStrong,
    color: colors.brand,
    alignSelf: 'center',
    padding: space.lg,
  },
});
