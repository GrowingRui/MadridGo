// Plan: the home screen. Tapping From or To turns the field into a text box in place, with stop
// suggestions under it (no separate page). As soon as both are set, connections appear right
// under the planner. On the website the planner is one row in the navy band and
// the connections sit beside the selected journey's details.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

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
import { PlanMap } from '../../components/planMap';
import { StopSuggestions } from '../../components/stopSearch';
import { TouchTimetable } from '../../components/touch';
import { StopRow } from '../../components/stops';
import { Rich } from '../../components/Rich';
import { useAsync, useIsWide, useNow, type PressState } from '../../hooks';
import { type MessageKey, useT } from '../../i18n';
import { journeyCache } from '../../state/journeys';
import {
  DEFAULT_SORT,
  HERE_ID,
  type Place,
  type PlanView,
  placeKey,
  setPlanner,
  swapPlaces,
  usePlanner,
} from '../../state/planner';
import { type SavedStop, addRecent, useSaved } from '../../state/saved';
import { colors, radius, space, type } from '../../theme';
import type { Point } from '../../utils/location';
import { formatDay, formatTime } from '../../utils/time';

export default function PlanScreen() {
  const { from, to, when, arriveBy, sort, view } = usePlanner();
  const isWide = useIsWide();
  const { t } = useT();
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
    setPlace({ id: s.id, name: s.name });
  };
  const chooseHere = (p: Point) => setPlace({ id: HERE_ID, name: t('here.title'), ...p });
  const setPlace = (place: Place) => {
    const field = editing ?? 'to';
    const otherField = field === 'from' ? 'to' : 'from';
    // "Current location" can be only one end: choosing it for this end clears the other.
    const clash = place.id === HERE_ID && (field === 'from' ? to : from)?.id === HERE_ID;
    setPlanner({ [field]: place, ...(clash ? { [otherField]: null } : null) });
    // Like a timetable app: after the origin, go straight on to the destination if it is empty.
    if (field === 'from' && (!to || clash)) edit('to');
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

  // Touch timetable: both ends chosen on the tiles, or one end chosen and the other to type.
  const planFromTiles = (a: Place, b: Place) => setPlanner({ from: a, to: b, view: 'timetable' });
  const typeFromTiles = (field: PlaceFieldName, known: Place | null) => {
    const otherEnd = field === 'to' ? 'from' : 'to';
    setPlanner({ view: 'timetable', ...(known ? { [otherEnd]: known, [field]: null } : null) });
    edit(field);
  };
  const switchView = (v: PlanView) => {
    close();
    setPlanner({ view: v });
  };

  const header = (
    <BrandHeader
      wide
      // App: "Where to?" with the logo on the right, hidden while typing to keep the form high.
      title={isWide ? t('plan.titleWide') : editing ? undefined : t('plan.whereTo')}
      subtitle={isWide ? t('plan.modes') : undefined}
      right={
        isWide || editing ? undefined : (
          <Image
            source={require('../../../assets/icon.png')}
            style={styles.logo}
            accessibilityLabel="MadridGo"
          />
        )
      }>
      {editing && !isWide ? null : <ViewSwitch view={view} onChange={switchView} />}
      {view !== 'timetable' ? null : isWide ? (
        <View style={styles.wideForm}>
          <PlannerCard
            {...card}
            layout="row"
            dropdown={
              <StopSuggestions
                text={text}
                onPick={choose}
                onHere={chooseHere}
                exclude={other}
                dropdown
              />
            }
          />
        </View>
      ) : (
        <PlannerCard {...card} />
      )}
    </BrandHeader>
  );

  if (view === 'map') {
    return (
      <Screen fill header={header}>
        <PlanMap />
      </Screen>
    );
  }

  return (
    <Screen wide header={header}>
      {view === 'touch' ? (
        <View style={styles.touch}>
          <TouchTimetable onPlan={planFromTiles} onTypeField={typeFromTiles} />
        </View>
      ) : editing && !isWide ? (
        // App: suggestions replace the content under the header while typing.
        <StopSuggestions text={text} onPick={choose} onHere={chooseHere} exclude={other} />
      ) : ready ? (
        // Keyed so "Earlier/Later" and the selection reset when the search changes.
        <Connections
          key={`${placeKey(from)}|${placeKey(to)}|${when}|${arriveBy}|${sort}`}
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
// Timetable | Touch timetable | Map

const VIEWS: { key: PlanView; label: MessageKey }[] = [
  { key: 'timetable', label: 'plan.view.timetable' },
  { key: 'touch', label: 'plan.view.touch' },
  { key: 'map', label: 'plan.view.map' },
];

function ViewSwitch({ view, onChange }: { view: PlanView; onChange: (v: PlanView) => void }) {
  const { t } = useT();
  return (
    <View style={styles.switch} accessibilityRole="tablist">
      {VIEWS.map((v) => {
        const active = v.key === view;
        return (
          <Pressable
            key={v.key}
            onPress={() => onChange(v.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={({ pressed, hovered }: PressState) => [
              styles.switchItem,
              active && styles.switchItemActive,
              !active && (pressed || hovered) && styles.switchItemHover,
            ]}>
            <Text
              style={[styles.switchText, active && styles.switchTextActive]}
              numberOfLines={1}>
              {t(v.label)}
            </Text>
          </Pressable>
        );
      })}
    </View>
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

/** A stop id, or the point for "Current location". */
const planPlace = (p: Place) => (p.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon } : p.id);

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
// Before a search: saved and recent stops

function Start() {
  const { from } = usePlanner();
  const saved = useSaved();
  const isWide = useIsWide();
  const { t } = useT();

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
      <SectionTitle>{from ? t('plan.chooseDestination') : t('plan.startFrom')}</SectionTitle>
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
      <Text style={styles.hintTitle}>{t('plan.hintTitle')}</Text>
      <Rich
        k="plan.hintBody"
        style={styles.hintBody}
        slots={{
          live: <Text style={{ color: colors.live, fontWeight: '700' }}>{t('status.live')}</Text>,
          scheduled: <Text style={{ fontWeight: '700' }}>{t('status.scheduled')}</Text>,
          every: (
            <Text style={{ color: colors.warning, fontWeight: '700' }}>
              {t('status.everyGeneric')}
            </Text>
          ),
        }}
      />
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
  logo: { width: 40, height: 40, borderRadius: 10 },
  switch: {
    flexDirection: 'row',
    backgroundColor: colors.brandDark,
    borderRadius: radius.pill,
    padding: 4,
    marginTop: space.md,
    marginBottom: space.xs,
  },
  // Sized by their labels ("Touch timetable" is the longest), sharing the rest of the row.
  switchItem: {
    flexGrow: 1,
    flexShrink: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  switchItemActive: { backgroundColor: colors.surface },
  switchItemHover: { backgroundColor: 'rgba(255,255,255,0.08)' },
  switchText: { ...type.smallStrong, fontSize: 15, color: colors.onBrandMuted },
  switchTextActive: { color: colors.brand, fontWeight: '700' },
  touch: { width: '100%', maxWidth: 640, alignSelf: 'center' },
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
