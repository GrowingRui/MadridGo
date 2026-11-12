// The list of connections for a From/To search, with Earlier/Later, timetable and live-data
// notices and the legend. In the app it fills the Connections screen (a tap opens the
// connection page); on the website the selected connection's details sit beside the list.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type Journey, planJourneys, type SortOption } from '../api/journeys';
import { useAsync, useIsWide, useNow, type PressState } from '../hooks';
import { useT } from '../i18n';
import { journeyCache } from '../state/journeys';
import { type Place, placeKey, planPlace } from '../state/planner';
import { colors, space, themed, type } from '../theme';
import { formatDay, formatTime } from '../utils/time';
import { ConnectionActions, ConnectionHeader } from './connection';
import { JourneyNotices, JourneyTimeline } from './journey';
import { Card, Divider, EmptyState, ErrorState, Loading, Notice } from './layout';
import { ConnectionCard } from './planner';
import { Rich } from './Rich';

export function ConnectionList({
  from,
  to,
  when,
  arriveBy,
  sort,
}: {
  from: Place;
  to: Place;
  when: number | null;
  arriveBy: boolean;
  sort: SortOption;
}) {
  const isWide = useIsWide();
  const { t } = useT();
  const now = useNow();
  // Earlier/Later pages come from the server's cursors; null is the first page.
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const plan = useAsync(
    () =>
      planJourneys({ from: planPlace(from), to: planPlace(to), at: when, arriveBy, sort, cursor }),
    `${placeKey(from)}|${placeKey(to)}|${when}|${cursor ?? ''}`,
  );
  const data = plan.data;

  useEffect(() => {
    data?.journeys.forEach((j) => journeyCache.set(j.id, j));
  }, [data]);

  if (!data) {
    if (plan.error) return <ErrorState message={plan.error} onRetry={plan.reload} />;
    return <Loading label={t('plan.finding')} />;
  }

  const page = (c: string | null) => {
    if (!c) return;
    setCursor(c);
    setSelected(0);
  };
  const open = (j: Journey, i: number) =>
    isWide ? setSelected(i) : router.push({ pathname: '/journey/[id]', params: { id: j.id } });
  const searched = Date.parse(data.search_time);

  const list = (
    <>
      <Text style={styles.listHead}>
        {t(data.arrive_by ? 'plan.headArriveBy' : 'plan.headFrom', {
          day: formatDay(searched),
          time: formatTime(searched),
        })}
        {plan.loading ? t('plan.updating') : ''}
      </Text>
      <Card>
        <PageLink
          label={t('plan.earlier')}
          icon="chevron-up"
          disabled={!data.earlier_cursor || plan.loading}
          onPress={() => page(data.earlier_cursor)}
        />
        {data.journeys.map((j, i) => (
          <View key={j.id}>
            <Divider />
            <ConnectionCard
              journey={j}
              now={now}
              selected={isWide && i === selected}
              onPress={() => open(j, i)}
            />
          </View>
        ))}
        {data.journeys.length === 0 ? (
          <>
            <Divider />
            <EmptyState
              icon="map-marker-off-outline"
              title={t('plan.noneTitle')}
              body={data.message ?? t('plan.noneBody')}
            />
          </>
        ) : null}
        <Divider />
        <PageLink
          label={t('plan.later')}
          icon="chevron-down"
          disabled={!data.later_cursor || plan.loading}
          onPress={() => page(data.later_cursor)}
        />
      </Card>
      <Legend />
    </>
  );

  // Timetable problems (expired feeds), then operators whose live data is down or outdated.
  const notices = (
    <>
      {data.notices.map((n) => (
        <Notice
          key={n.source}
          tone={n.expiry === 'expired' ? 'danger' : 'warning'}
          icon="calendar-alert">
          {n.message}
        </Notice>
      ))}
      {data.realtime
        .filter((s) => s.status === 'stale' || s.status === 'unavailable')
        .map((s) => (
          <Notice key={s.feed} tone="info" icon="access-point-off" title={s.operator}>
            {s.message}
          </Notice>
        ))}
      {data.message && data.journeys.length ? (
        <Notice tone="info" icon="information-outline">
          {data.message}
        </Notice>
      ) : null}
    </>
  );

  if (!isWide) {
    return (
      <>
        <View style={styles.notices}>{notices}</View>
        {list}
      </>
    );
  }

  const current = data.journeys[selected] ?? data.journeys[0];
  return (
    <>
      <View style={styles.notices}>{notices}</View>
      <View style={styles.split}>
        <View style={styles.splitList}>{list}</View>
        <View style={styles.splitDetail}>
          {current ? (
            <Card style={styles.detailCard}>
              <ConnectionHeader journey={current} />
              <View style={styles.detailActions}>
                <ConnectionActions journey={current} from={from} to={to} />
              </View>
              <JourneyNotices journey={current} />
              <Divider />
              <JourneyTimeline journey={current} />
            </Card>
          ) : null}
        </View>
      </View>
    </>
  );
}


function PageLink({
  label,
  icon,
  onPress,
  disabled,
}: {
  label: string;
  icon: 'chevron-up' | 'chevron-down';
  onPress: () => void;
  disabled?: boolean;
}) {
  const color = disabled ? colors.textFaint : colors.brand;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed, hovered }: PressState) => [
        styles.pageLink,
        !disabled && (pressed || hovered) && { backgroundColor: colors.pressed },
      ]}>
      <MaterialCommunityIcons name={icon} size={20} color={color} />
      <Text style={[styles.pageLinkText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function Legend() {
  const { t } = useT();
  return (
    <Rich
      k="plan.legend"
      style={styles.legend}
      slots={{
        live: <Text style={{ color: colors.live, fontWeight: '700' }}>{t('status.live')}</Text>,
        delay: <Text style={{ color: colors.delay }}>+4′</Text>,
        scheduled: <Text style={{ fontWeight: '700' }}>{t('status.scheduled')}</Text>,
        frequency: (
          <Text style={{ color: colors.warning, fontWeight: '700' }}>{t('status.frequency')}</Text>
        ),
      }}
    />
  );
}

// ---------------------------------------------------------------------------
const styles = themed(() =>
  StyleSheet.create({
    detailActions: { marginTop: -space.md, marginBottom: space.sm, marginLeft: -space.md },
    listHead: {
      ...type.smallStrong,
      color: colors.textMuted,
      marginHorizontal: space.lg,
      marginTop: space.lg,
      marginBottom: space.sm,
    },
    pageLink: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.xs,
      paddingVertical: space.md,
    },
    pageLinkText: { ...type.smallStrong, color: colors.brand },
    legend: {
      ...type.small,
      color: colors.textMuted,
      marginHorizontal: space.lg,
      marginTop: space.md,
      lineHeight: 19,
    },
    notices: { gap: space.sm, marginTop: space.lg, marginHorizontal: space.lg },
    split: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: space.sm },
    splitList: { width: 460 },
    splitDetail: { flex: 1, marginTop: space.lg },
    detailCard: { marginTop: space.xl + space.sm },
  }),
);
