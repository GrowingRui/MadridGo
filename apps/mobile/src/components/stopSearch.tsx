// Stop suggestions for a search text, laid out like a timetable app's search list: "Current
// location" first, then starred stops, then recent ones (clock, empty star to save), and once
// two letters are typed, matches from /stops/search. Every stop row has a star to save or remove
// it. Used under the planner (in place), in the website's dropdown and in the departures picker.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Fragment, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { type StopSummary, nearbyStops, searchStops } from '../api/stops';
import { useAsync, useDebounced } from '../hooks';
import { t, useT } from '../i18n';
import { type SavedStop, isFavorite, toSaved, toggleFavorite, useSaved } from '../state/saved';
import { colors, space, themed, type } from '../theme';
import { LocationError, type Point, getCurrentPoint } from '../utils/location';
import { Card, Divider, EmptyState, ErrorState, Loading, SectionTitle } from './layout';
import { StarButton, StopRow } from './stops';

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
}: {
  text: string;
  onPick: (s: SavedStop) => void;
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
  if (results.loading && !results.data) return <Loading label={t('search.searching')} />;
  if (results.error) return <ErrorState message={results.error} onRetry={results.reload} />;
  const found = (results.data ?? []).filter((s) => s.id !== exclude);
  if (!found.length) {
    return dropdown ? (
      <Text style={styles.hint}>{t('search.noMatch', { q })}.</Text>
    ) : (
      <EmptyState
        icon="map-marker-question-outline"
        title={t('search.noMatch', { q })}
        body={t('search.noMatchBody')}
      />
    );
  }
  const byId = new Map(found.map((s) => [s.id, s]));
  return (
    <Group first>
      {rows(found.map(toSaved), {
        detail: (s) => {
          const full = byId.get(s.id);
          return full ? detail(full) : null;
        },
      })}
    </Group>
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

/** Stops within 600 m of a point, nearest first, each with its distance and a star. */
export function NearbyStops({
  point,
  onPick,
  onHere,
}: {
  point: Point;
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
      <SectionTitle>{t('nearby.title')}</SectionTitle>
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
            </View>
          ))}
        </Card>
      )}
    </>
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
  hint: { ...type.small, color: colors.textMuted, padding: space.lg },
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
