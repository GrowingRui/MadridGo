// Saved: favourite stops, kept only on this device.

import { router } from 'expo-router';
import { View } from 'react-native';

import {
  BrandHeader,
  Card,
  Divider,
  EmptyState,
  Screen,
  SectionTitle,
} from '../../components/layout';
import { StarButton, StopRow } from '../../components/stops';
import { useT } from '../../i18n';
import { toggleFavorite, useSaved } from '../../state/saved';

export default function SavedScreen() {
  const { favorites } = useSaved();
  const { t } = useT();
  return (
    <Screen header={<BrandHeader title={t('saved.title')} subtitle={t('saved.subtitle')} />}>
      {favorites.length ? (
        <>
          <SectionTitle>{t('saved.stops')}</SectionTitle>
          <Card>
            {favorites.map((s, i) => (
              <View key={s.id}>
                {i > 0 ? <Divider inset={56} /> : null}
                <StopRow
                  name={s.name}
                  modes={s.modes}
                  lines={s.lines}
                  onPress={() => router.push({ pathname: '/stop/[id]', params: { id: s.id } })}
                  trailing={<StarButton name={s.name} saved onPress={() => toggleFavorite(s)} />}
                />
              </View>
            ))}
          </Card>
        </>
      ) : (
        <EmptyState icon="star-outline" title={t('saved.emptyTitle')} body={t('saved.emptyBody')} />
      )}
    </Screen>
  );
}
