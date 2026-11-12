// Trip screen: every stop of one journey leg's vehicle, from its origin to its terminus, with
// the train's point moving along the line (opens when the ride is tapped on a journey).

import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { getTrip } from '../api/trips';
import {
  BrandHeader,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Notice,
  Screen,
} from '../components/layout';
import { LinePill, lineColors, modeLabel } from '../components/transit';
import { TripRoute, TripStatus } from '../components/trip';
import { useAsync, useLegBus, useNow, useTripPosition } from '../hooks';
import { useT } from '../i18n';
import { journeyCache } from '../state/journeys';
import { colors, modeColors, space, themed } from '../theme';
import { canTrackBus } from '../utils/busPosition';
import { canTrack } from '../utils/trainPosition';

export default function TripScreen() {
  const { t, tn } = useT();
  const params = useLocalSearchParams<{ journey: string; leg: string }>();
  const leg = journeyCache.get(params.journey)?.legs[Number(params.leg)];
  const tripId = leg?.trip_id ?? null;
  const trip = useAsync(
    tripId
      ? () =>
          getTrip(tripId, {
            fromStop: leg?.from_stop_id,
            toStop: leg?.to_stop_id,
            departure: leg?.departure.scheduled,
          })
      : null,
    `${tripId}:${leg?.departure.scheduled}`,
  );
  const slowNow = useNow(60_000);
  const pos = useTripPosition(tripId, leg?.from_stop_id, !!leg && canTrack(leg, slowNow));
  const bus = useLegBus(leg);
  const tracked = !!leg && (canTrack(leg, slowNow) || canTrackBus(leg, slowNow));
  const now = useNow(pos || bus ? 1000 : 60_000);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (!leg || !tripId) {
    return (
      <Screen header={<BrandHeader title={t('trip.title')} onBack={back} />}>
        <EmptyState icon="map-marker-path" title={t('trip.gone')} body={t('journey.searchAgain')} />
      </Screen>
    );
  }
  const color = leg.line ? lineColors(leg.line).bg : (modeColors[leg.mode]?.bg ?? colors.brand);
  const data = trip.data;
  const first = data?.stops[0]?.name;
  const lastStop = data?.stops[data.stops.length - 1]?.name;
  const direction = lastStop ?? leg.headsign;

  return (
    <Screen
      header={
        <BrandHeader
          title={`${modeLabel(leg.mode)}${direction ? ` · ${t('conn.direction', { name: direction })}` : ''}`}
          subtitle={
            data
              ? tn('trip.subtitle', data.stops.length, { from: first ?? '', to: lastStop ?? '' })
              : `${leg.from} → ${leg.to}`
          }
          onBack={back}>
          {leg.line ? (
            <View style={styles.pill}>
              <LinePill line={leg.line} />
            </View>
          ) : null}
        </BrandHeader>
      }>
      {trip.loading && !data ? <Loading label={t('trip.loading')} /> : null}
      {trip.error && !data ? <ErrorState message={trip.error} onRetry={trip.reload} /> : null}
      {data ? (
        <>
          {pos?.kind === 'estimated' ? (
            <View style={{ marginTop: space.lg }}>
              <Notice tone="info" icon="information-outline" title={t('trip.estimatedTitle')}>
                {t('trip.estimatedBody')}
              </Notice>
            </View>
          ) : null}
          <Card style={{ marginTop: space.lg }}>
            <TripStatus trip={data} pos={pos} bus={bus} leg={leg} now={now} tracked={tracked} />
            <TripRoute trip={data} color={color} pos={pos} bus={bus} leg={leg} now={now} />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = themed(() => StyleSheet.create({
  pill: { marginTop: space.sm, flexDirection: 'row' },
}));
