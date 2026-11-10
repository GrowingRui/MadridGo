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
import { LinePill, MODE_LABEL, lineColors } from '../components/transit';
import { TripRoute, TripStatus } from '../components/trip';
import { useAsync, useNow, useTripPosition } from '../hooks';
import { journeyCache } from '../state/journeys';
import { colors, modeColors, space } from '../theme';
import { canTrack } from '../utils/trainPosition';

export default function TripScreen() {
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
  const tracked = !!leg && canTrack(leg, slowNow);
  const pos = useTripPosition(tripId, leg?.from_stop_id, tracked);
  const now = useNow(pos ? 1000 : 60_000);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (!leg || !tripId) {
    return (
      <Screen header={<BrandHeader title="Trip" onBack={back} />}>
        <EmptyState
          icon="map-marker-path"
          title="This trip is no longer available"
          body="Search again to see current connections."
        />
      </Screen>
    );
  }
  const color = leg.line ? lineColors(leg.line).bg : (modeColors[leg.mode]?.bg ?? colors.brand);
  const data = trip.data;
  const first = data?.stops[0]?.name;
  const lastStop = data?.stops[data.stops.length - 1]?.name;

  return (
    <Screen
      header={
        <BrandHeader
          title={`${MODE_LABEL[leg.mode]}${(lastStop ?? leg.headsign) ? ` · Direction ${lastStop ?? leg.headsign}` : ''}`}
          subtitle={
            data ? `${first} → ${lastStop} · ${data.stops.length} stops` : `${leg.from} → ${leg.to}`
          }
          onBack={back}>
          {leg.line ? (
            <View style={styles.pill}>
              <LinePill line={leg.line} />
            </View>
          ) : null}
        </BrandHeader>
      }>
      {trip.loading && !data ? <Loading label="Loading the route…" /> : null}
      {trip.error && !data ? <ErrorState message={trip.error} onRetry={trip.reload} /> : null}
      {data ? (
        <>
          {pos?.kind === 'estimated' ? (
            <View style={{ marginTop: space.lg }}>
              <Notice tone="info" icon="information-outline" title="Estimated position">
                Renfe gives no live position for this train right now, so the point follows the
                timetable.
              </Notice>
            </View>
          ) : null}
          <Card style={{ marginTop: space.lg }}>
            <TripStatus trip={data} pos={pos} now={now} tracked={tracked} />
            <TripRoute trip={data} color={color} pos={pos} now={now} />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pill: { marginTop: space.sm, flexDirection: 'row' },
});
