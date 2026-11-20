// Trips tab, as in SBB Mobile: the connections saved with ☆ (only on this device), until they
// have arrived. While the tab is open, trips on the way or leaving within two hours get their
// live times again every minute.

import { useIsFocused } from 'expo-router';

import { CommuteSection } from '../../components/commute';
import { DisruptionsButton } from '../../components/disruptions';
import { BrandHeader, Screen } from '../../components/layout';
import { NoTrips, TripList } from '../../components/trips';
import { useIsWide } from '../../hooks';
import { useT } from '../../i18n';
import { useCommutes } from '../../state/commutes';
import { useSavedConnections, useTripRefresh } from '../../state/connections';

export default function TripsScreen() {
  const { t } = useT();
  const isWide = useIsWide();
  const trips = useSavedConnections(15_000);
  const focused = useIsFocused();
  const { commutes } = useCommutes();
  useTripRefresh(focused && trips.length > 0);
  return (
    <Screen
      header={
        <BrandHeader
          title={t('trips.title')}
          subtitle={t('trips.subtitle')}
          right={isWide ? undefined : <DisruptionsButton />}
        />
      }>
      <CommuteSection active={focused} />
      {trips.length ? <TripList trips={trips} /> : commutes.length ? null : <NoTrips />}
    </Screen>
  );
}
