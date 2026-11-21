// Stop suggestions for a search text, laid out like a timetable app's search list: "Current
// location" first, then starred stops, then recent ones (clock, empty star to save), and once
// two letters are typed, matches from /stops/search. Every stop row has a star to save or remove
// it. With `onPlace`, from three letters it also lists addresses and places (/places/search) under
// the stops. Used under the planner (in place), in the website's dropdown and in the departures
// picker.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Fragment, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PLACE_MIN_CHARS, type PlaceResult, placeIcon, searchPlaces } from '../api/places';
import { type StopSummary, bestTime, nearbyStops, searchStops, stopBoard } from '../api/stops';
import { useAsync, useDebounced, useNow } from '../hooks';
import { t, useT } from '../i18n';
import { type SavedStop, isFavorite, toSaved, toggleFavorite, useSaved } from '../state/saved';
import { colors, space, themed, type } from '../theme';
import { LocationError, type Point, getCurrentPoint } from '../utils/location';
import { countdownShort } from '../utils/time';
import { Card, Divider, EmptyState, ErrorState, Loading, SectionTitle } from './layout';
import { StarButton, StopRow } from './stops';
import { LinePill } from './transit';

const detail = (s: StopSummary) =>
  [
    s.is_station ? t('search.station') : t('search.stop'),
    s.code ? t('search.code', { code: s.code }) : null,
    s.distance_m != null ? t('search.distance', { m: Math.round(s.distance_m) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** "Station · code 123 · 80 m away" for a search or nearby result. */
export const stopDetail = detail;

export function StopSuggestions({
  text,
  onPick,
  onHere,
  exclude,
  dropdown,
  onPlace,
}: {
  text: string;
  onPick: (s: SavedStop) => void;
  /** Also searches addresses and places (from 3 letters), listed after the stops. */
  onPlace?: (p: PlaceResult) => void;
  /** Shows "Current location" first; called with the traveller's position once found. */
  onHere?: (p: Point) => void;
  /** A stop not to suggest (the other end of the journey). */
  exclude?: string;
  /** Compact rendering for the website's dropdown panel (no cards, no big empty states). */
  dropdown?: boolean;
}) {
  const { t } = useT();
  const q = useDebounced(text.trim(), 250);
  const saved = useSaved();
  const results = useAsync(q.length >= 2 ? () => searchStops(q) : null, q);
  const places = useAsync(
    onPlace && q.length >= PLACE_MIN_CHARS ? () => searchPlaces(q) : null,
    onPlace ? q : '',
  );
  const Group = dropdown ? DropdownGroup : SpacedCard;

  const rows = (
    stops: SavedStop[],
    opts: { icon?: 'history'; detail?: (s: SavedStop) => string | null } = {},
  ) =>
    stops.map((s, i) => (
      <View key={s.id}>
        {i > 0 ? <Divider inset={56} /> : null}
        <StopRow
          name={s.name}
          modes={s.modes}
          lines={s.lines}
          icon={opts.icon}
          detail={opts.detail?.(s)}
          onPress={() => onPick(s)}
          trailing={
            <StarButton
              name={s.name}
              saved={isFavorite(s.id, saved)}
              onPress={() => toggleFavorite(s)}
            />
          }
        />
      </View>
    ));

  if (q.length < 2) {
    const favorites = saved.favorites.filter((f) => f.id !== exclude);
    const recents = saved.recents
      .filter((r) => r.id !== exclude && !favorites.some((f) => f.id === r.id))
      .slice(0, 6);
    const groups = [
      onHere ? <CurrentLocationRow key="here" onFound={onHere} /> : null,
      favorites.length ? <Fragment key="fav">{rows(favorites)}</Fragment> : null,
      recents.length ? <Fragment key="recent">{rows(recents, { icon: 'history' })}</Fragment> : null,
    ].filter(Boolean);
    const empty = !favorites.length && !recents.length;
    return (
      <>
        {groups.map((g, i) => (
          <Group key={i} first={i === 0}>
            {g}
          </Group>
        ))}
        {empty ? (
          dropdown ? (
            <Text style={styles.hint}>{t('search.typeHint')}</Text>
          ) : (
            <EmptyState
              icon="map-search-outline"
              title={t('search.emptyTitle')}
              body={t('search.emptyBody')}
            />
          )
        ) : null}
      </>
    );
  }
  const askPlaces = !!onPlace && q.length >= PLACE_MIN_CHARS;
  const placesDone = !askPlaces || !!places.data || !!places.error;
  if (results.loading && !results.data && (!askPlaces || !places.data)) {
    return <Loading label={t('search.searching')} />;
  }
  const found = (results.data ?? []).filter((s) => s.id !== exclude);
  const foundPlaces = askPlaces ? (places.data ?? []) : [];
  if (results.error && !foundPlaces.length && placesDone) {
    return <ErrorState message={results.error} onRetry={results.reload} />;
  }
  if (!found.length && !foundPlaces.length && placesDone && !results.loading) {
    // Only the stops answered when the address search is down: say so with the "no match".
    const noun = onPlace ? 'search.noMatchAny' : 'search.noMatch';
    return dropdown ? (
      <>
        <Text style={styles.hint}>{t(noun, { q })}.</Text>
        {places.error ? <Text style={styles.hint}>{t('search.placesUnavailable')}</Text> : null}
      </>
    ) : (
      <EmptyState
        icon="map-marker-question-outline"
        title={t(noun, { q })}
        body={
          places.error
            ? t('search.placesUnavailable')
            : t(onPlace ? 'search.noMatchAnyBody' : 'search.noMatchBody')
        }
      />
    );
  }
  const byId = new Map(found.map((s) => [s.id, s]));
  const titled = askPlaces; // two groups: name them
  return (
    <>
      {found.length ? (
        <>
          {titled ? <GroupTitle dropdown={dropdown} text={t('search.stops')} /> : null}
          <Group first={!titled}>
            {rows(found.map(toSaved), {
              detail: (s) => {
                const full = byId.get(s.id);
                return full ? detail(full) : null;
              },
            })}
          </Group>
        </>
      ) : null}
      {askPlaces && onPlace ? (
        <>
          <GroupTitle dropdown={dropdown} text={t('search.places')} />
          {foundPlaces.length ? (
            <Group first>
              {foundPlaces.map((p, i) => (
                <View key={p.id}>
                  {i > 0 ? <Divider inset={56} /> : null}
                  <StopRow
                    name={p.name}
                    modes={[]}
                    lines={[]}
                    icon={placeIcon(p.kind)}
                    detail={p.detail}
                    onPress={() => onPlace(p)}
                  />
                </View>
              ))}
            </Group>
          ) : null}
          {!placesDone ? (
            <Text style={styles.hint}>{t('search.placesSearching')}</Text>
          ) : places.error ? (
            <Text style={styles.hint}>{t('search.placesUnavailable')}</Text>
          ) : !foundPlaces.length ? (
            <Text style={styles.hint}>{t('search.noPlaces', { q })}</Text>
          ) : (
            <Text style={styles.credit}>{t('search.placesCredit')}</Text>
          )}
        </>
      ) : null}
    </>
  );
}

function GroupTitle({ text, dropdown }: { text: string; dropdown?: boolean }) {
  return dropdown ? (
    <Text style={styles.dropdownTitle} accessibilityRole="header">
      {text}
    </Text>
  ) : (
    <SectionTitle>{text}</SectionTitle>
  );
}

/**
 * "Current location": asks for the position only when tapped. While locating it shows a
 * spinner; a refusal or a position outside the Madrid area is explained in the row itself.
 */
export function CurrentLocationRow({ onFound }: { onFound: (p: Point) => void }) {
  const { t } = useT();
  const [state, setState] = useState<'idle' | 'locating' | LocationError['problem']>('idle');

  const locate = async () => {
    setState('locating');
    try {
      const p = await getCurrentPoint();
      setState('idle');
      onFound(p);
    } catch (err) {
      setState(err instanceof LocationError ? err.problem : 'failed');
    }
  };

  const problem =
    state === 'denied'
      ? t('here.denied')
      : state === 'outside'
        ? t('here.outside')
        : state === 'failed'
          ? t('here.failed')
          : null;

  return (
    <Pressable
      onPress={locate}
      disabled={state === 'locating'}
      accessibilityRole="button"
      accessibilityLabel={problem ? `${t('here.title')}, ${problem}` : t('here.title')}
      accessibilityState={{ busy: state === 'locating' }}
      style={({ pressed }) => [styles.here, pressed && styles.pressed]}>
      <View style={styles.hereIcon}>
        {state === 'locating' ? (
          <ActivityIndicator size="small" color={colors.brand} />
        ) : (
          <MaterialCommunityIcons name="crosshairs-gps" size={22} color={colors.brand} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.hereTitle}>
          {state === 'locating' ? t('here.locating') : t('here.title')}
        </Text>
        {problem ? <Text style={styles.hereProblem}>{problem}</Text> : null}
      </View>
    </Pressable>
  );
}

/** Stops within 600 m of a point (you, or an address), nearest first, each with its distance
 * and a star. */
export function NearbyStops({
  point,
  title,
  onPick,
  onHere,
}: {
  point: Point;
  /** "Stops near Calle Mayor 5"; default "Stops near you". */
  title?: string;
  onPick: (s: SavedStop) => void;
  /** "Current location" again, to look from a new position. */
  onHere: (p: Point) => void;
}) {
  const { t } = useT();
  const saved = useSaved();
  const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
  const near = useAsync(() => nearbyStops(point.lat, point.lon), key);
  return (
    <>
      <SpacedCard first>
        <CurrentLocationRow onFound={onHere} />
      </SpacedCard>
      <SectionTitle>{title ?? t('nearby.title')}</SectionTitle>
      {near.error ? (
        <ErrorState message={near.error} onRetry={near.reload} />
      ) : !near.data ? (
        <Loading />
      ) : !near.data.length ? (
        <EmptyState icon="map-marker-off-outline" title={t('nearby.none')} />
      ) : (
        <Card>
          {near.data.map((s, i) => (
            <View key={s.id}>
              {i > 0 ? <Divider inset={56} /> : null}
              <StopRow
                name={s.name}
                modes={s.modes}
                lines={s.lines}
                detail={detail(s)}
                onPress={() => onPick(toSaved(s))}
                trailing={
                  <StarButton
                    name={s.name}
                    saved={isFavorite(s.id, saved)}
                    onPress={() => toggleFavorite(toSaved(s))}
                  />
                }
              />
              {i < NEXT_LIMIT ? <NextUp stopId={s.id} /> : null}
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

/** Only the nearest stops fetch a board, so a crowded area does not fire dozens of requests. */
const NEXT_LIMIT = 6;

interface Next {
  key: string;
  line: StopSummary['lines'][number];
  at: string;
}

/**
 * The next few departures at a nearby stop, as line pills with minutes away (live times when
 * known). Metro and EMT lines with no exact times show their frequency instead. Fails quietly:
 * the stop row above still works.
 */
function NextUp({ stopId }: { stopId: string }) {
  const { t } = useT();
  const board = useAsync(() => stopBoard(stopId, 60), stopId);
  const now = useNow();
  if (board.error) return <Text style={styles.nextHint}>{t('nearby.nextFail')}</Text>;
  if (!board.data) return <Text style={styles.nextHint}>…</Text>;
  const b = board.data;
  const timed: Next[] = [
    ...b.departures.filter((d) => d.status !== 'cancelled').map((d) => ({
      key: `d:${d.trip_id}`,
      line: d.line,
      at: bestTime(d),
    })),
    ...b.live_arrivals
      .filter((a) => a.time)
      .map((a, i) => ({ key: `l:${a.line.route_id}:${i}`, line: a.line, at: a.time as string })),
  ]
    .filter((n) => Date.parse(n.at) > now - 60_000)
    .sort((a, c) => Date.parse(a.at) - Date.parse(c.at))
    .slice(0, 3);
  const freq = timed.length ? [] : b.frequencies.slice(0, 2);
  if (!timed.length && !freq.length)
    return <Text style={styles.nextHint}>{t('nearby.nextNone')}</Text>;
  return (
    <View style={styles.next}>
      {timed.map((n) => (
        <View key={n.key} style={styles.nextItem}>
          <LinePill line={n.line} size="sm" />
          <Text style={styles.nextTime}>{countdownShort(n.at, now) ?? ''}</Text>
        </View>
      ))}
      {freq.map((f, i) => (
        <View key={`f${i}`} style={styles.nextItem}>
          <LinePill line={f.line} size="sm" />
          <Text style={styles.nextTime}>{t('nearby.nextFreq', { n: f.headway_min })}</Text>
        </View>
      ))}
    </View>
  );
}

function SpacedCard({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return <Card style={{ marginTop: first ? space.lg : space.md }}>{children}</Card>;
}

function DropdownGroup({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <View>
      {first ? null : <View style={styles.dropdownGap} />}
      {children}
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  next: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingLeft: 56,
    paddingRight: space.lg,
    paddingBottom: space.md,
  },
  nextItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  nextTime: { ...type.smallStrong, color: colors.live },
  nextHint: {
    ...type.small,
    color: colors.textFaint,
    paddingLeft: 56,
    paddingRight: space.lg,
    paddingBottom: space.md,
  },
  hint: { ...type.small, color: colors.textMuted, padding: space.lg },
  credit: {
    ...type.small,
    color: colors.textFaint,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    textAlign: 'right',
  },
  dropdownTitle: {
    ...type.small,
    fontWeight: '600',
    color: colors.textMuted,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
    backgroundColor: colors.bg,
  },
  dropdownGap: { height: space.sm, backgroundColor: colors.bg },
  here: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md + 2,
    paddingHorizontal: space.lg,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.pressed },
  hereIcon: { width: 28, alignItems: 'center' },
  hereTitle: { ...type.bodyStrong, color: colors.text },
  hereProblem: { ...type.small, color: colors.textMuted },
}));
