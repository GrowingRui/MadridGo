// Departure board for a stop or station: timetables plus live data where an authorized
// source exists (Renfe GTFS-RT, EMT MobilityLabs). Every source's status is shown.
// Stations also have an Arrivals board (SBB's Departures | Arrivals switch).

import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { BoardKind, DataNotice, SourceStatus } from '../../api/stops';
import { bestTime, boardRows, expiredNotice, hasArrivals, stopBoard } from '../../api/stops';
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
import { useAsync, useNow, type PressState } from '../../hooks';
import { useT } from '../../i18n';
import { setPlanner } from '../../state/planner';
import { addRecent, isFavorite, toSaved, toggleFavorite, useSaved } from '../../state/saved';
import { colors, radius, space, themed, type } from '../../theme';
import { formatIsoDate, formatTime } from '../../utils/time';
import { AccessLine } from '../../components/access';

export default function StopBoardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useT();
  const [kind, setKind] = useState<BoardKind>('departures');
  const board = useAsync(() => stopBoard(id, 90, kind), `${id}|${kind}`);
  const saved = useSaved();
  const now = useNow();
  const stop = board.data?.stop;
  const arrivals = kind === 'arrivals';
  // While the other board loads, the last one is still in `data`: do not show it as this one.
  const current = board.data && (board.data.kind ?? 'departures') === kind ? board.data : null;

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
  const upcoming = current
    ? boardRows(current).filter((d) => Date.parse(bestTime(d)) >= now - 60_000)
    : [];
  const liveArrivals = current?.live_arrivals ?? [];

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
          {stop && hasArrivals(stop) ? (
            <View style={styles.tabs} accessibilityRole="tablist">
              {(['departures', 'arrivals'] as const).map((k) => {
                const active = k === kind;
                return (
                  <Pressable
                    key={k}
                    onPress={() => setKind(k)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    style={({ pressed, hovered }: PressState) => [
                      styles.tab,
                      active && styles.tabActive,
                      !active && (pressed || hovered) && styles.tabHover,
                    ]}>
                    <Text style={[styles.tabText, active && styles.tabTextActive]}>
                      {t(k === 'arrivals' ? 'arr.tabArrivals' : 'arr.tabDepartures')}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </BrandHeader>
      }>
      {board.error ? (
        <ErrorState message={board.error} onRetry={board.reload} />
      ) : !current ? (
        <Loading label={t(arrivals ? 'arr.loading' : 'board.loading')} />
      ) : (
        <>
          <AccessLine
            ok={current.step_free}
            yes={t('access.stationBoard')}
            no={t('access.noStationBoard')}
            style={styles.liveLine}
          />
          {current.notices.map((n) => (
            <Notice
              key={n.source}
              tone={n.expiry === 'expired' ? 'danger' : 'warning'}
              title={n.operator}>
              {n.message}
            </Notice>
          ))}
          {current.realtime
            // "Times come from the timetable" says nothing useful when that timetable has
            // expired: the expiry notice above already explains why there are no times.
            .filter(
              (st) =>
                !(
                  st.status === 'not_available' &&
                  current.notices.some((n) => n.source === st.feed && n.expiry === 'expired')
                ),
            )
            .map((st) => (
              <SourceNotice key={st.feed} st={st} />
            ))}

          {current.alerts.length ? (
            <>
              <SectionTitle>{t('board.alerts')}</SectionTitle>
              <Card>
                {current.alerts.slice(0, 5).map((a, i) => (
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

          {current.frequencies.length ? (
            <>
              <SectionTitle>{t('board.frequent')}</SectionTitle>
              <Card>
                {current.frequencies.map((f, i) => (
                  <View key={`${f.line.route_id}-${f.headsign}-${f.origin}-${f.stop_id}`}>
                    {i > 0 ? <Divider inset={space.lg} /> : null}
                    <FrequencyRow f={f} arrival={arrivals} />
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {upcoming.length ? (
            <>
              <SectionTitle>{t(arrivals ? 'arr.next' : 'board.next')}</SectionTitle>
              <Card>
                {upcoming.map((d, i) => (
                  <View key={`${d.trip_id}-${d.time}`}>
                    {i > 0 ? <Divider inset={space.lg} /> : null}
                    <DepartureRow dep={d} now={now} arrival={arrivals} />
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {!upcoming.length && !current.frequencies.length && !liveArrivals.length ? (
            <EmptyBoard
              notice={expiredNotice(current)}
              title={t(arrivals ? 'arr.noneTitle' : 'board.noneTitle')}
            />
          ) : null}

          <Text style={styles.footer}>
            {t('board.updated', { time: formatTime(current.generated_at) })} · Powered by CRTM ·
            Renfe (CC BY 4.0) · Powered by EMT de Madrid
          </Text>
        </>
      )}
    </Screen>
  );
}

/**
 * Nothing to show. When a timetable has expired, that is the reason, so say it: "service may
 * have ended for today" would wrongly suggest the line is not running.
 */
function EmptyBoard({ notice, title }: { notice: DataNotice | null; title: string }) {
  const { t } = useT();
  if (notice) {
    return (
      <EmptyState
        icon="calendar-remove-outline"
        title={t('board.expiredTitle', { operator: notice.operator })}
        body={
          notice.service_end
            ? t('board.expiredBody', { date: formatIsoDate(notice.service_end) })
            : t('board.expiredBodyNoDate')
        }
      />
    );
  }
  return <EmptyState icon="clock-remove-outline" title={title} body={t('board.noneBody')} />;
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
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.headerDark,
    borderRadius: radius.pill,
    padding: 4,
    marginTop: space.md,
  },
  tab: {
    flexGrow: 1,
    flexBasis: 0,
    alignItems: 'center',
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  tabActive: { backgroundColor: colors.surface },
  tabHover: { backgroundColor: 'rgba(255,255,255,0.08)' },
  tabText: { ...type.smallStrong, color: colors.onBrandMuted },
  tabTextActive: { color: colors.brand, fontWeight: '700' },
}));
