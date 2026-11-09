// Plan: the home screen. Tapping From or To turns the field into a text box in place, with stop
// suggestions under it (no separate page). As soon as both are set, connections appear right
// under the planner. On the website the planner is one row in the navy band and
// the connections sit beside the selected journey's details.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type Journey, planJourneys, type SortOption } from '../../api/journeys';
import { JourneyNotices, JourneySummary, JourneyTimeline } from '../../components/journey';
import {
  BrandHeader,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Loading,
  Notice,
  Screen,
  SectionTitle,
} from '../../components/layout';
import { ConnectionCard, type PlaceFieldName, PlannerCard } from '../../components/planner';
import { OptionsSheet, TimeSheet, WhenBar } from '../../components/when';
import { StopSuggestions } from '../../components/stopSearch';
import { StopRow } from '../../components/stops';
import { useAsync, useIsWide, useNow, type PressState } from '../../hooks';
import { journeyCache } from '../../state/journeys';
import { DEFAULT_SORT, type Place, setPlanner, swapPlaces, usePlanner } from '../../state/planner';
import { type SavedStop, addRecent, useSaved } from '../../state/saved';
import { colors, space, type } from '../../theme';
import { formatDay, formatTime } from '../../utils/time';

export default function PlanScreen() {
  const { from, to, when, arriveBy, sort } = usePlanner();
  const isWide = useIsWide();
  const [sheet, setSheet] = useState<'time' | 'options' | null>(null);
  // The field being typed into, in place in the header (no separate search page).
  const [editing, setEditing] = useState<PlaceFieldName | null>(null);
  const [text, setText] = useState('');
  const ready = !!from && !!to;

  const edit = (field: PlaceFieldName) => {
    setEditing(field);
    setText('');
  };
  const close = () => {
    setEditing(null);
    setText('');
  };
  const choose = (s: SavedStop) => {
    addRecent(s);
    setPlanner({ [editing ?? 'to']: { id: s.id, name: s.name } });
    // Like a timetable app: after the origin, go straight on to the destination if it is empty.
    if (editing === 'from' && !to) edit('to');
    else close();
  };

  const other = editing === 'from' ? to?.id : from?.id;
  const card = {
    from,
    to,
    onSwap: swapPlaces,
    editing,
    text,
    onEdit: edit,
    onText: setText,
    onClose: close,
    footer:
      editing && !isWide ? null : (
        <WhenBar
          when={when}
          arriveBy={arriveBy}
          optionsActive={sort !== DEFAULT_SORT}
          onOpenTime={() => setSheet('time')}
          onNow={() => setPlanner({ when: null, arriveBy: false })}
          onOpenOptions={() => setSheet('options')}
        />
      ),
  };

  const header = (
    <BrandHeader
      wide
      title={isWide ? 'Plan your journey' : ready || editing ? undefined : 'Where to?'}
      subtitle={isWide ? 'Metro · Cercanías · Bus · Metro Ligero' : undefined}>
      {isWide ? (
        <View style={styles.wideForm}>
          <PlannerCard
            {...card}
            layout="row"
            dropdown={<StopSuggestions text={text} onPick={choose} exclude={other} dropdown />}
          />
        </View>
      ) : (
        <PlannerCard {...card} />
      )}
    </BrandHeader>
  );

  return (
    <Screen wide header={header}>
      {editing && !isWide ? (
        // App: suggestions replace the content under the header while typing.
        <StopSuggestions text={text} onPick={choose} exclude={other} />
      ) : ready ? (
        // Keyed so "Earlier/Later" and the selection reset when the search changes.
        <Connections
          key={`${from.id}|${to.id}|${when}|${arriveBy}|${sort}`}
          from={from}
          to={to}
          when={when}
          arriveBy={arriveBy}
          sort={sort}
        />
      ) : (
        <Start />
      )}
      <TimeSheet
        visible={sheet === 'time'}
        when={when}
        arriveBy={arriveBy}
        onClose={() => setSheet(null)}
        onApply={(w, a) => {
          setPlanner({ when: w, arriveBy: a });
          setSheet(null);
        }}
      />
      <OptionsSheet
        visible={sheet === 'options'}
        sort={sort}
        onClose={() => setSheet(null)}
        onApply={(v) => setPlanner({ sort: v })}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Connections

function Connections({
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
  const now = useNow();
  // Earlier/Later pages come from the server's cursors; null is the first page.
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const plan = useAsync(
    () => planJourneys({ from: from.id, to: to.id, at: when, arriveBy, sort, cursor }),
    `${from.id}|${to.id}|${when}|${cursor ?? ''}`,
  );
  const data = plan.data;

  useEffect(() => {
    data?.journeys.forEach((j) => journeyCache.set(j.id, j));
  }, [data]);

  if (!data) {
    if (plan.error) return <ErrorState message={plan.error} onRetry={plan.reload} />;
    return <Loading label="Finding connections…" />;
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
        {formatDay(searched)} · {data.arrive_by ? 'arrive by' : 'from'} {formatTime(searched)}
        {plan.loading ? ' · updating…' : ''}
      </Text>
      <Card>
        <PageLink
          label="Earlier connections"
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
              title="No connections found"
              body={data.message ?? 'Try another time or nearby stops.'}
            />
          </>
        ) : null}
        <Divider />
        <PageLink
          label="Later connections"
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
              <JourneySummary journey={current} />
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
        !disabled && (pressed || hovered) && { backgroundColor: '#F7F8FA' },
      ]}>
      <MaterialCommunityIcons name={icon} size={20} color={color} />
      <Text style={[styles.pageLinkText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function Legend() {
  return (
    <Text style={styles.legend}>
      <Text style={{ color: colors.live, fontWeight: '700' }}>Live</Text> times come from the
      operator&apos;s real-time feed; a red <Text style={{ color: colors.delay }}>+4′</Text> is the
      delay. <Text style={{ fontWeight: '700' }}>Scheduled</Text> times are the official timetable.{' '}
      <Text style={{ color: colors.warning, fontWeight: '700' }}>Frequency</Text> lines publish only
      “every N minutes”. Changes are marked tight, at risk or uncertain when the time to change is
      short or cannot be known.
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Before a search: saved and recent stops

function Start() {
  const { from } = usePlanner();
  const saved = useSaved();
  const isWide = useIsWide();

  const pickInto = (s: SavedStop) => {
    if (!from) setPlanner({ from: { id: s.id, name: s.name } });
    else setPlanner({ to: { id: s.id, name: s.name } });
  };

  // Saved first, then recents, never the stop already chosen as origin.
  const quick = [
    ...saved.favorites,
    ...saved.recents.filter((r) => !saved.favorites.some((f) => f.id === r.id)),
  ].filter((s) => s.id !== from?.id);

  const picks = quick.length ? (
    <View>
      <SectionTitle>{from ? 'Choose a destination' : 'Start from'}</SectionTitle>
      <Card>
        {quick.slice(0, 6).map((s, i) => (
          <View key={s.id}>
            {i > 0 ? <Divider inset={56} /> : null}
            <StopRow name={s.name} modes={s.modes} lines={s.lines} onPress={() => pickInto(s)} />
          </View>
        ))}
      </Card>
    </View>
  ) : null;

  const hint = (
    <View style={styles.hint}>
      <Text style={styles.hintTitle}>Plan door to door across Madrid</Text>
      <Text style={styles.hintBody}>
        Choose where you start and where you are going. Every time MadridGo shows is labelled{' '}
        <Text style={{ color: colors.live, fontWeight: '700' }}>Live</Text>,{' '}
        <Text style={{ fontWeight: '700' }}>Scheduled</Text> or{' '}
        <Text style={{ color: colors.warning, fontWeight: '700' }}>Every ~N min</Text>, so you
        always know how much to trust it.
      </Text>
    </View>
  );

  if (isWide) {
    return (
      <View style={styles.split}>
        <View style={styles.splitList}>{picks ?? hint}</View>
        <View style={styles.splitDetail}>{picks ? hint : null}</View>
      </View>
    );
  }
  return picks ?? hint;
}

const styles = StyleSheet.create({
  // zIndex: the suggestion dropdown must cover the time chips below the form.
  wideForm: { flexDirection: 'row', marginTop: space.lg, zIndex: 20 },
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
  hint: { margin: space.lg, marginTop: space.xl, gap: space.sm },
  hintTitle: { ...type.heading, color: colors.text },
  hintBody: { ...type.body, color: colors.textMuted, lineHeight: 22 },
});
