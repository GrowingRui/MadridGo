// Stop suggestions for a search text: saved and recent stops while the text is short, then
// matches from /stops/search. Used under the planner (in place, like a timetable app) and in the
// departures picker.

import { StyleSheet, Text, View } from 'react-native';

import { type StopSummary, searchStops } from '../api/stops';
import { useAsync, useDebounced } from '../hooks';
import { t, useT } from '../i18n';
import { type SavedStop, toSaved, useSaved } from '../state/saved';
import { colors, space, type } from '../theme';
import { Card, Divider, EmptyState, ErrorState, Loading, SectionTitle } from './layout';
import { StopRow } from './stops';

const detail = (s: StopSummary) =>
  [
    s.is_station ? t('search.station') : t('search.stop'),
    s.code ? t('search.code', { code: s.code }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

export function StopSuggestions({
  text,
  onPick,
  exclude,
  dropdown,
}: {
  text: string;
  onPick: (s: SavedStop) => void;
  /** A stop not to suggest (the other end of the journey). */
  exclude?: string;
  /** Compact rendering for the website's dropdown panel (no cards, no big empty states). */
  dropdown?: boolean;
}) {
  const { t } = useT();
  const q = useDebounced(text.trim(), 250);
  const saved = useSaved();
  const results = useAsync(q.length >= 2 ? () => searchStops(q) : null, q);
  const List = dropdown ? View : Card;

  const rows = (stops: SavedStop[], withDetail?: (s: SavedStop) => string | null) => (
    <List>
      {stops
        .filter((s) => s.id !== exclude)
        .map((s, i) => (
          <View key={s.id}>
            {i > 0 ? <Divider inset={56} /> : null}
            <StopRow
              name={s.name}
              modes={s.modes}
              lines={s.lines}
              detail={withDetail?.(s)}
              onPress={() => onPick(s)}
            />
          </View>
        ))}
    </List>
  );

  if (q.length < 2) {
    const favorites = saved.favorites.filter((f) => f.id !== exclude);
    const recents = saved.recents.filter(
      (r) => r.id !== exclude && !favorites.some((f) => f.id === r.id),
    );
    if (!favorites.length && !recents.length) {
      return dropdown ? (
        <Text style={styles.hint}>{t('search.typeHint')}</Text>
      ) : (
        <EmptyState
          icon="map-search-outline"
          title={t('search.emptyTitle')}
          body={t('search.emptyBody')}
        />
      );
    }
    const Title = dropdown ? DropdownTitle : SectionTitle;
    return (
      <>
        {favorites.length ? <Title>{t('section.saved')}</Title> : null}
        {favorites.length ? rows(favorites) : null}
        {recents.length ? <Title>{t('section.recent')}</Title> : null}
        {recents.length ? rows(recents.slice(0, 6)) : null}
      </>
    );
  }
  if (results.loading && !results.data) return <Loading label={t('search.searching')} />;
  if (results.error) return <ErrorState message={results.error} onRetry={results.reload} />;
  if (!results.data?.length) {
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
  const byId = new Map(results.data.map((s) => [s.id, s]));
  return (
    <View style={dropdown ? undefined : { marginTop: space.lg }}>
      {rows(results.data.map(toSaved), (s) => {
        const full = byId.get(s.id);
        return full ? detail(full) : null;
      })}
    </View>
  );
}

function DropdownTitle({ children }: { children: string }) {
  return <Text style={styles.dropdownTitle}>{children}</Text>;
}

const styles = StyleSheet.create({
  hint: { ...type.small, color: colors.textMuted, padding: space.lg },
  dropdownTitle: {
    ...type.label,
    fontSize: 11,
    color: colors.textFaint,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
});
