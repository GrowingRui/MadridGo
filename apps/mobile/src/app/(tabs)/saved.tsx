// Saved: favourite stops, kept only on this device.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import {
  BrandHeader,
  Card,
  Divider,
  EmptyState,
  Screen,
  SectionTitle,
} from '../../components/layout';
import { StopRow } from '../../components/stops';
import { toggleFavorite, useSaved } from '../../state/saved';
import { colors } from '../../theme';

export default function SavedScreen() {
  const { favorites } = useSaved();
  return (
    <Screen header={<BrandHeader title="Saved" subtitle="Stored on this device only" />}>
      {favorites.length ? (
        <>
          <SectionTitle>Stops</SectionTitle>
          <Card>
            {favorites.map((s, i) => (
              <View key={s.id}>
                {i > 0 ? <Divider inset={56} /> : null}
                <StopRow
                  name={s.name}
                  modes={s.modes}
                  lines={s.lines}
                  onPress={() => router.push({ pathname: '/stop/[id]', params: { id: s.id } })}
                  trailing={
                    <Pressable
                      onPress={() => toggleFavorite(s)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${s.name} from saved`}
                      hitSlop={10}>
                      <MaterialCommunityIcons name="star" size={22} color={colors.accent} />
                    </Pressable>
                  }
                />
              </View>
            ))}
          </Card>
        </>
      ) : (
        <EmptyState
          icon="star-outline"
          title="Nothing saved yet"
          body="Open a stop's departures and tap the star to keep it here. Saved stops also appear as quick picks in the planner."
        />
      )}
    </Screen>
  );
}
