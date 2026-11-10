// Departure board for a stop or station: timetables plus live data where an authorized
// source exists (Renfe GTFS-RT, EMT MobilityLabs). Every source's status is shown.

import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { SourceStatus } from '../../api/stops';
import { bestTime, stopBoard } from '../../api/stops';
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
import { DepartureRow, FrequencyRow, LiveArrivalRow } from '../../components/stops';
import { LinePills, modeLabel } from '../../components/transit';
import { useAsync, useNow } from '../../hooks';
import { useT } from '../../i18n';
import { setPlanner } from '../../state/planner';
import { addRecent, isFavorite, toSaved, toggleFavorite, useSaved } from '../../state/saved';
import { colors, space, themed, type } from '../../theme';
import { formatTime } from '../../utils/time';

export default function StopBoardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useT();
  const board = useAsync(() => stopBoard(id), id);
  const saved = useSaved();
  const now = useNow();
  const stop = board.data?.stop;

  // Refresh while open: every 30 s when the board has live data, else every minute.
  const { reload } = board;
  const live = board.data?.data_quality === 'partly_live';
  useEffect(() => {
    const t = setInterval(reload, live ? 30_000 : 60_000);
    return () => clearInterval(t);
  }, [reload, live]);

  useEffect(() => {
    if (stop) addRecent(toSaved(stop));
  }, [stop]);

  const fav = stop ? isFavorite(stop.id, saved) : false;
  const upcoming =
    board.data?.departures.filter((d) => Date.parse(bestTime(d)) >= now - 60_000) ?? [];
  const liveArrivals = board.data?.live_arrivals ?? [];

  return (
    <Screen
      refreshing={board.loading && !!board.data}
      onRefresh={board.reload}
      header={
        <BrandHeader
          title={stop?.name ?? t('dep.title')}
          subtitle={
            stop
              ? stop.modes.map((m) => modeLabel(m)).join(' · ') +
                (stop.code ? ` · ${t('board.stopCode', { code: stop.code })}` : '')
              : undefined
          }
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/departures'))}
          right={
            stop ? (
              <View style={styles.actions}>
                <HeaderIconButton
                  icon="map-marker-path"
                  label={t('board.planFromHere')}
                  onPress={() => {
                    setPlanner({ from: { id: stop.id, name: stop.name } });
                    router.navigate('/');
                  }}
                />
                <HeaderIconButton
                  icon={fav ? 'star' : 'star-outline'}
                  label={fav ? t('board.unsave') : t('board.save')}
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
        <Loading label={t('board.loading')} />
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
          {board.data.realtime.map((st) => (
            <SourceNotice key={st.feed} st={st} />
          ))}

          {board.data.alerts.length ? (
            <>
              <SectionTitle>{t('board.alerts')}</SectionTitle>
              <Card>
                {board.data.alerts.slice(0, 5).map((a, i) => (
                  <View key={a.source_alert_id} style={styles.alert}>
                    {i > 0 ? <Divider /> : null}
                    {a.header ? <Text style={styles.alertTitle}>{a.header}</Text> : null}
                    {a.description && a.description !== a.header ? (
                      <Text style={styles.alertBody} numberOfLines={4}>
                        {a.description}
                      </Text>
                    ) : null}
                    <Text style={styles.alertSource}>
                      {a.operator === 'EMT_MADRID' ? 'EMT Madrid' : 'Renfe Cercanías'}
                    </Text>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {liveArrivals.length ? (
            <>
              <SectionTitle>{t('board.liveArrivals')}</SectionTitle>
              <Card>
                {liveArrivals.map((a, i) => (
                  <View key={`${a.line.route_id}-${a.realtime.vehicle_id ?? i}-${a.time}`}>
                    {i > 0 ? <Divider inset={space.lg} /> : null}
                    <LiveArrivalRow a={a} now={now} />
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {board.data.frequencies.length ? (
            <>
              <SectionTitle>{t('board.frequent')}</SectionTitle>
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
              <SectionTitle>{t('board.next')}</SectionTitle>
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

          {!upcoming.length && !board.data.frequencies.length && !liveArrivals.length ? (
            <EmptyState
              icon="clock-remove-outline"
              title={t('board.noneTitle')}
              body={t('board.noneBody')}
            />
          ) : null}

          <Text style={styles.footer}>
            {t('board.updated', { time: formatTime(board.data.generated_at) })} · Powered by CRTM ·
            Renfe (CC BY 4.0) · Powered by EMT de Madrid
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

/** "12 s" / "3 min": the age of live data, put into a sentence by the caller. */
function age(s: number | null | undefined): string {
  if (s == null) return '?';
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

/**
 * One line per operator saying what kind of times the board shows for it. Live sources that
 * are healthy get a quiet line; degraded or missing live data gets a visible notice.
 */
function SourceNotice({ st }: { st: SourceStatus }) {
  const { t } = useT();
  if (st.status === 'live') {
    const key = st.freshness?.age_basis === 'retrieved' ? 'board.liveFetched' : 'board.liveUpdated';
    return (
      <View style={styles.liveLine} accessibilityRole="text">
        <View style={styles.liveDot} />
        <Text style={styles.liveText}>
          {t(key, { operator: st.operator, age: age(st.freshness?.age_s) })}
        </Text>
      </View>
    );
  }
  if (st.status === 'not_available') {
    return (
      <Notice
        tone="info"
        icon="clock-outline"
        title={t('board.scheduledTitle', { operator: st.operator })}>
        {st.message}
      </Notice>
    );
  }
  return (
    <Notice
      tone="warning"
      icon={st.status === 'delayed_update' ? 'clock-alert-outline' : 'access-point-network-off'}
      title={t(st.status === 'delayed_update' ? 'board.liveTitle' : 'board.noLiveTitle', {
        operator: st.operator,
      })}>
      {st.message}
    </Notice>
  );
}

const styles = themed(() => StyleSheet.create({
  actions: { flexDirection: 'row', gap: space.lg },
  liveLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.md,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.live },
  liveText: { ...type.small, color: colors.textMuted },
  alert: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 4 },
  alertTitle: { ...type.bodyStrong, color: colors.text },
  alertBody: { ...type.small, color: colors.text },
  alertSource: { ...type.small, color: colors.textFaint },
  footer: { ...type.small, color: colors.textFaint, textAlign: 'center', margin: space.lg },
}));
