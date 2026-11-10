// Route map of one connection (the map button on a connection): each leg drawn in its line
// colour along its real path, walks dashed, and its stops. Tapping a stop opens its departures.

import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { BrandHeader, EmptyState, Screen } from '../components/layout';
import { type MapHandle, MapFrame } from '../components/mapFrame';
import { mapHtml } from '../components/mapHtml';
import { useT } from '../i18n';
import { journeyCache } from '../state/journeys';
import { currentScheme } from '../theme';
import { routeFeatures } from '../utils/route';

export default function RouteMapScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const journey = journeyCache.get(id);
  const map = useRef<MapHandle>(null);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const html = useMemo(
    () => mapHtml({ departures: t('map.departures'), zoomIn: t('map.zoomIn') }, currentScheme()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang],
  );

  if (!journey) {
    return (
      <Screen header={<BrandHeader title={t('routeMap.title')} onBack={back} />}>
        <EmptyState
          icon="map-marker-path"
          title={t('journey.gone')}
          body={t('journey.searchAgain')}
        />
      </Screen>
    );
  }
  const first = journey.legs[0];
  const last = journey.legs[journey.legs.length - 1];
  const onMessage = (msg: { type: string; [k: string]: unknown }) => {
    if (msg.type === 'ready') map.current?.post({ type: 'route', ...routeFeatures(journey) });
    else if (msg.type === 'stop') {
      router.push({ pathname: '/stop/[id]', params: { id: String(msg.id) } });
    }
  };
  return (
    <Screen
      fill
      header={
        <BrandHeader
          title={t('routeMap.title')}
          subtitle={`${first.from} → ${last.to}`}
          onBack={back}
        />
      }>
      <View style={styles.wrap}>
        <MapFrame ref={map} html={html} onMessage={onMessage} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 420, overflow: 'hidden' },
});
