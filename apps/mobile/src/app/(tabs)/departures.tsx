// Departures tab: pick a stop to see its board; recent and saved stops for one-tap access.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  BrandHeader,
  Card,
  Divider,
  EmptyState,
  Screen,
  SectionTitle,
} from '../../components/layout';
import { StopRow } from '../../components/stops';
import { type SavedStop, clearRecents, useSaved } from '../../state/saved';
import { colors, radius, space, type } from '../../theme';

export default function DeparturesScreen() {
  const saved = useSaved();
  const open = (s: SavedStop) => router.push({ pathname: '/stop/[id]', params: { id: s.id } });
  return (
    <Screen
      header={
        <BrandHeader title="Departures" subtitle="Next trains, Metro and buses from any stop">
          <Pressable
            onPress={() => router.push({ pathname: '/pick', params: { field: 'board' } })}
            accessibilityRole="search"
            style={styles.fakeSearch}>
            <MaterialCommunityIcons name="magnify" size={22} color={colors.textMuted} />
            <Text style={styles.fakeSearchText}>Stop, station or stop code</Text>
          </Pressable>
        </BrandHeader>
      }>
      {saved.favorites.length ? (
        <>
          <SectionTitle>Saved</SectionTitle>
          <List stops={saved.favorites} onPress={open} />
        </>
      ) : null}
      {saved.recents.length ? (
        <>
          <SectionTitle
            action={
              <Text onPress={clearRecents} style={styles.clear} accessibilityRole="button">
                Clear
              </Text>
            }>
            Recent
          </SectionTitle>
          <List stops={saved.recents} onPress={open} />
        </>
      ) : null}
      {!saved.favorites.length && !saved.recents.length ? (
        <EmptyState
          icon="clock-outline"
          title="Find your stop"
          body="Search for a stop to see its next departures. Tap the star on a board to keep it here."
        />
      ) : null}
    </Screen>
  );
}

function List({ stops, onPress }: { stops: SavedStop[]; onPress: (s: SavedStop) => void }) {
  return (
    <Card>
      {stops.map((s, i) => (
        <View key={s.id}>
          {i > 0 ? <Divider inset={56} /> : null}
          <StopRow name={s.name} modes={s.modes} lines={s.lines} onPress={() => onPress(s)} />
        </View>
      ))}
    </Card>
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
  clear: { ...type.smallStrong, color: colors.brand },
});
