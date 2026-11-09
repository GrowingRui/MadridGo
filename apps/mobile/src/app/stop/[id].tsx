// Departure board for a stop or station (real data from the backend's static timetables).

import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { stopBoard } from '../../api/stops';
import {
  BrandHeader,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  HeaderIconButton,
  Loading,
  Notice,
  Screen,
  SectionTitle,
} from '../../components/layout';
import { DepartureRow, FrequencyRow } from '../../components/stops';
import { LinePills, MODE_LABEL } from '../../components/transit';
import { useAsync, useNow } from '../../hooks';
import { setPlanner } from '../../state/planner';
import { addRecent, isFavorite, toSaved, toggleFavorite, useSaved } from '../../state/saved';
import { colors, space, type } from '../../theme';
import { formatTime } from '../../utils/time';

export default function StopBoardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const board = useAsync(() => stopBoard(id), id);
  const saved = useSaved();
  const now = useNow();
  const stop = board.data?.stop;

  // Refresh the board every minute while it is open.
  const { reload } = board;
  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (stop) addRecent(toSaved(stop));
  }, [stop]);

  const fav = stop ? isFavorite(stop.id, saved) : false;
  const upcoming = board.data?.departures.filter((d) => Date.parse(d.time) >= now - 60_000) ?? [];

  return (
    <Screen
      refreshing={board.loading && !!board.data}
      onRefresh={board.reload}
      header={
        <BrandHeader
          title={stop?.name ?? 'Departures'}
          subtitle={
            stop
              ? stop.modes.map((m) => MODE_LABEL[m]).join(' · ') +
                (stop.code ? ` · stop ${stop.code}` : '')
              : undefined
          }
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/departures'))}
          right={
            stop ? (
              <View style={styles.actions}>
                <HeaderIconButton
                  icon="map-marker-path"
                  label="Plan a journey from here"
                  onPress={() => {
                    setPlanner({ from: { id: stop.id, name: stop.name } });
                    router.navigate('/');
                  }}
                />
                <HeaderIconButton
                  icon={fav ? 'star' : 'star-outline'}
                  label={fav ? 'Remove from saved' : 'Save stop'}
                  onPress={() => toggleFavorite(toSaved(stop))}
                />
              </View>
            ) : null
          }>
          {stop?.lines.length ? (
            <View style={{ marginTop: space.md }}>
              <LinePills lines={stop.lines} max={14} onDark />
            </View>
          ) : null}
        </BrandHeader>
      }>
      {board.loading && !board.data ? (
        <Loading label="Loading departures…" />
      ) : board.error ? (
        <ErrorState message={board.error} onRetry={board.reload} />
      ) : board.data ? (
        <>
          {board.data.notices.map((n) => (
            <Notice
              key={n.source}
              tone={n.expiry === 'expired' ? 'danger' : 'warning'}
              title={n.operator}>
              {n.message}
            </Notice>
          ))}
          <Notice tone="info" icon="clock-outline" title="Scheduled times">
            Live arrivals are coming in Phase 3. These are the official timetables.
          </Notice>

          {board.data.frequencies.length ? (
            <>
              <SectionTitle>Frequent lines</SectionTitle>
              <Card>
                {board.data.frequencies.map((f, i) => (
                  <View key={`${f.line.route_id}-${f.headsign}-${f.stop_id}`}>
                    {i > 0 ? <Divider inset={space.lg} /> : null}
                    <FrequencyRow f={f} />
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {upcoming.length ? (
            <>
              <SectionTitle>Next departures</SectionTitle>
              <Card>
                {upcoming.map((d, i) => (
                  <View key={`${d.trip_id}-${d.time}`}>
                    {i > 0 ? <Divider inset={space.lg} /> : null}
                    <DepartureRow dep={d} now={now} />
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {!upcoming.length && !board.data.frequencies.length ? (
            <EmptyState
              icon="clock-remove-outline"
              title="No departures in the next 90 minutes"
              body="Service may have ended for today, or this stop is not served at this time."
            />
          ) : null}

          <Text style={styles.footer}>
            Updated {formatTime(board.data.generated_at)} · Powered by CRTM, Renfe and EMT de Madrid
            open data
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: space.lg },
  footer: { ...type.small, color: colors.textFaint, textAlign: 'center', margin: space.lg },
});
