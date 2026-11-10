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
import { useT } from '../../i18n';
import { type SavedStop, clearRecents, useSaved } from '../../state/saved';
import { colors, radius, space, type } from '../../theme';

export default function DeparturesScreen() {
  const saved = useSaved();
  const { t } = useT();
  const open = (s: SavedStop) => router.push({ pathname: '/stop/[id]', params: { id: s.id } });
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
      {saved.favorites.length ? (
        <>
          <SectionTitle>{t('section.saved')}</SectionTitle>
          <List stops={saved.favorites} onPress={open} />
        </>
      ) : null}
      {saved.recents.length ? (
        <>
          <SectionTitle
            action={
              <Text onPress={clearRecents} style={styles.clear} accessibilityRole="button">
                {t('common.clear')}
              </Text>
            }>
            {t('section.recent')}
          </SectionTitle>
          <List stops={saved.recents} onPress={open} />
        </>
      ) : null}
      {!saved.favorites.length && !saved.recents.length ? (
        <EmptyState icon="clock-outline" title={t('dep.emptyTitle')} body={t('dep.emptyBody')} />
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
