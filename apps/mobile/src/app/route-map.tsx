// Route map of one connection (the map button on a connection): each leg drawn in its line
// colour along its real path, walks dashed, and its stops. Tapping a stop opens its departures.
//
// Live trip map (as in SBB Mobile's "Live" map of a single trip): while a Cercanías ride of the
// connection is on or coming (from 90 min before), its train moves on the map with the same
// rules and labels as the journey timeline (solid = live, hollow = estimated), and a card under
// the map says where it is, the next stop and when you board and get off. The same for an EMT
// bus ride (from 45 min before): its point comes from EMT's arrivals (utils/busPosition.ts).
// Opened from the connection's map button and from "Live map" on a trip in the Trips tab.

import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BrandHeader, EmptyState, Screen } from '../components/layout';
import { LiveBusCard } from '../components/liveBus';
import { LiveTrainCard } from '../components/liveTrain';
import { type MapHandle, MapFrame } from '../components/mapFrame';
import { mapHtml } from '../components/mapHtml';
import { lineColors } from '../components/transit';
import { useBusPosition, useNow, useReduceMotion, useTripPosition } from '../hooks';
import { useT } from '../i18n';
import { savedConnection, useSavedConnections, useTripRefresh } from '../state/connections';
import { journeyCache } from '../state/journeys';
import { currentScheme, modeColors } from '../theme';
import { busPoint } from '../utils/busPosition';
import { followedLeg, trainPoint } from '../utils/liveMap';
import { decodePolyline } from '../utils/polyline';
import { routeFeatures } from '../utils/route';

export default function RouteMapScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  useSavedConnections(); // re-renders when a saved trip gets fresh times
  const saved = savedConnection(id);
  // A saved trip's copy is refreshed every minute while on the way (useTripRefresh).
  const journey = saved?.journey ?? journeyCache.get(id);
  useTripRefresh(!!saved);
  const map = useRef<MapHandle>(null);
  const [ready, setReady] = useState(false);
  const reduceMotion = useReduceMotion();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const html = useMemo(
    () => mapHtml({ departures: t('map.departures'), zoomIn: t('map.zoomIn') }, currentScheme()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang],
  );

  const slowNow = useNow(30_000);
  const legIndex = journey ? followedLeg(journey, slowNow) : null;
  const leg = legIndex != null ? journey!.legs[legIndex] : null;
  const bus = !!leg?.trip_id?.startsWith('emt:');
  const pos = useTripPosition(leg?.trip_id, leg?.from_stop_id, !!leg && !bus);
  const busPos = useBusPosition(leg, !!leg && bus);
  const now = useNow(pos || busPos ? 1000 : 30_000);
  // The leg's track, so the train follows it (decoded once, not every second).
  const geometry = leg?.geometry;
  const track = useMemo(() => (geometry ? decodePolyline(geometry) : undefined), [geometry]);
  const point = leg && bus ? busPoint(busPos, leg, now) : trainPoint(pos, now, track);
  const color = leg?.line ? lineColors(leg.line).bg : modeColors.rail.bg;

  // Send the train's place every second (it moves with the clock between updates).
  const key = point ? `${point.lon.toFixed(6)},${point.lat.toFixed(6)},${point.estimated}` : '';
  useEffect(() => {
    if (!ready) return;
    map.current?.post(
      point
        ? { type: 'train', ...point, color, glide: !reduceMotion }
        : { type: 'train', hide: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key, color, reduceMotion]);

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
    if (msg.type === 'ready') {
      map.current?.post({ type: 'route', ...routeFeatures(journey) });
      setReady(true);
    } else if (msg.type === 'stop') {
      router.push({ pathname: '/stop/[id]', params: { id: String(msg.id) } });
    }
  };
  return (
    <Screen
      fill
      header={
        <BrandHeader
          title={leg ? t('liveMap.title') : t('routeMap.title')}
          subtitle={`${first.from} → ${last.to}`}
          onBack={back}
        />
      }>
      <View style={styles.wrap}>
        <MapFrame ref={map} html={html} onMessage={onMessage} />
      </View>
      {leg && bus ? <LiveBusCard leg={leg} pos={busPos} now={now} /> : null}
      {leg && !bus ? <LiveTrainCard leg={leg} pos={pos} now={now} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 320, overflow: 'hidden' },
});
