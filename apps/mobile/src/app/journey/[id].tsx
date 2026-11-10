// Connection page (app), laid out like SBB Mobile's: a "Connection" bar, then a card that
// overlaps it with From → To, day and travel time and the connection's line, round buttons to
// save it and to see the route on a map, then alerts and the timeline. On the website the
// same parts also appear beside the list of connections.

import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Journey } from '../../api/journeys';
import { ConnectionActions, ConnectionCard, ConnectionHeader } from '../../components/connection';
import { JourneyNotices, JourneyTimeline } from '../../components/journey';
import { BrandHeader, Card, EmptyState, Notice, Screen } from '../../components/layout';
import { useT } from '../../i18n';
import { refreshConnection, savedConnection, useSavedConnections } from '../../state/connections';
import { journeyCache } from '../../state/journeys';
import { usePlanner } from '../../state/planner';
import { colors, space, themed } from '../../theme';
import { formatTime } from '../../utils/time';

/** A saved connection's times are refreshed when they are older than this. */
const FRESH_MS = 60_000;

export default function JourneyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useT();
  const planner = usePlanner();
  useSavedConnections(); // loads saved connections, re-renders when they change
  const saved = savedConnection(id);
  const [fresh, setFresh] = useState<Journey | null>(null);
  const [notOffered, setNotOffered] = useState(false);
  const journey = fresh ?? journeyCache.get(id) ?? saved?.journey;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // A saved connection: ask the planner for it again so its times and labels are current.
  const savedAt = saved?.updatedAt;
  useEffect(() => {
    const s = savedConnection(id);
    if (!s || Date.now() - s.updatedAt < FRESH_MS) return;
    let alive = true;
    refreshConnection(s)
      .then((j) => {
        if (!alive) return;
        if (j) {
          journeyCache.set(j.id, j);
          setFresh(j);
        } else {
          setNotOffered(true);
        }
      })
      .catch(() => alive && setNotOffered(true));
    return () => {
      alive = false;
    };
    // Once per saved connection; savedAt is there so a late load still triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, savedAt != null]);

  const header = <BrandHeader title={t('conn.title')} onBack={back} />;
  if (!journey) {
    return (
      <Screen header={header}>
        <EmptyState
          icon="map-marker-path"
          title={t('journey.gone')}
          body={t('journey.searchAgain')}
        />
      </Screen>
    );
  }
  // What was planned, so the connection can be saved: the saved copy's, else the planner's.
  const from = saved?.from ?? planner.from;
  const to = saved?.to ?? planner.to;
  return (
    <Screen header={header}>
      {/* The card starts on the navy bar and runs onto the page, as in SBB Mobile. */}
      <View>
        <View style={styles.band} />
        <ConnectionCard>
          <ConnectionHeader journey={journey} />
        </ConnectionCard>
      </View>
      <ConnectionActions journey={journey} from={from} to={to} />
      {notOffered && saved ? (
        <View style={styles.notice}>
          <Notice tone="warning" icon="clock-alert-outline">
            {t('conn.notOffered', { time: formatTime(saved.updatedAt) })}
          </Notice>
        </View>
      ) : null}
      <View>
        <JourneyNotices journey={journey} />
        <Card style={{ marginTop: space.lg }}>
          <JourneyTimeline journey={journey} />
        </Card>
      </View>
    </Screen>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    band: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 56,
      backgroundColor: colors.header,
    },
    notice: { marginHorizontal: space.lg, marginTop: space.lg },
  }),
);
