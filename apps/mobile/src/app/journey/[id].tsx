// Journey details page (app; on the website the same timeline also appears beside the list).

import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { shownTime } from '../../api/journeys';
import { JourneyNotices, JourneyTimeline } from '../../components/journey';
import { BrandHeader, Card, EmptyState, Screen } from '../../components/layout';
import { changesLabel, PearlChain } from '../../components/planner';
import { useT } from '../../i18n';
import { journeyCache } from '../../state/journeys';
import { colors, space } from '../../theme';
import { formatDuration, formatTime } from '../../utils/time';

export default function JourneyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useT();
  const journey = journeyCache.get(id);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  if (!journey) {
    return (
      <Screen header={<BrandHeader title={t('journey.title')} onBack={back} />}>
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
  return (
    <Screen
      header={
        <BrandHeader
          title={`${first.from} → ${last.to}`}
          subtitle={`${formatTime(shownTime(journey.departure))} – ${formatTime(
            shownTime(journey.arrival),
          )} · ${formatDuration(journey.duration_min)} · ${changesLabel(journey.transfers)}`}
          onBack={back}>
          {/* White strip: dark line colours (C4 navy) would vanish on the brand header. */}
          <View style={styles.chainStrip}>
            <PearlChain legs={journey.legs} />
          </View>
        </BrandHeader>
      }>
      <JourneyNotices journey={journey} />
      <Card style={{ marginTop: space.lg }}>
        <JourneyTimeline journey={journey} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chainStrip: {
    marginTop: space.md,
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
});
