// How punctual each Cercanías line usually is (GET /punctuality): the figures behind
// "Usually ~N min late", per line and per time of the week. Opens from More and the website
// footer. Cercanías only: Metro and EMT publish no punctuality data.

import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import {
  BANDS,
  type LinePunctuality,
  type PunctualityEntry,
  getPunctuality,
  onTime,
  worstBand,
} from '../api/punctuality';
import {
  BrandHeader,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Loading,
  Screen,
} from '../components/layout';
import { LinePill } from '../components/transit';
import { useAsync, useIsWide } from '../hooks';
import { type MessageKey, useT } from '../i18n';
import { colors, space, themed, type } from '../theme';

export default function PunctualityScreen() {
  const { t } = useT();
  const isWide = useIsWide();
  const { data, error, loading, reload } = useAsync(() => getPunctuality(), 'punctuality');
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  return (
    <Screen
      refreshing={loading && !!data}
      onRefresh={reload}
      header={
        <BrandHeader
          title={t('pun.title')}
          subtitle={data ? t('pun.subtitle', { operator: data.operator_name }) : undefined}
          onBack={isWide ? undefined : back}
        />
      }>
      {!data && loading ? <Loading /> : null}
      {!data && error ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? (
        <View>
          <Text style={styles.intro}>{t('pun.intro')}</Text>
          {data.available ? (
            <>
              {data.lines.map((lp) => (
                <LineCard key={lp.line.short_name} lp={lp} />
              ))}
              <Text style={styles.note}>{t('pun.method')}</Text>
            </>
          ) : (
            <EmptyState
              icon="chart-box-outline"
              title={t('pun.none')}
              body={t('pun.noneBody', { min: data.min_days })}
            />
          )}
        </View>
      ) : null}
    </Screen>
  );
}

/** "Usually ~4 min late" / "Usually on time", in the same words as on a train. */
function headline(e: PunctualityEntry, t: ReturnType<typeof useT>['t']): string {
  return onTime(e) ? t('usual.onTime') : t('usual.late', { n: e.minutes });
}

function LineCard({ lp }: { lp: LinePunctuality }) {
  const { t } = useT();
  const worst = worstBand(lp);
  const bands = BANDS.flatMap((b) => (lp.bands[b] ? [[b, lp.bands[b] as PunctualityEntry] as const] : []));
  const when = (b: (typeof BANDS)[number]) => t(`pun.band.${b}` as MessageKey);
  const often =
    lp.overall && (!onTime(lp.overall) || lp.overall.often_minutes > 1)
      ? t('pun.often', { n: lp.overall.often_minutes })
      : null;
  return (
    <Card style={styles.card}>
      <View
        style={styles.head}
        accessible
        accessibilityLabel={`${lp.line.short_name}, ${lp.overall ? headline(lp.overall, t) : ''}${often ? `, ${often}` : ''}`}>
        <LinePill line={lp.line} />
        <View style={{ flex: 1, gap: 2 }}>
          {lp.overall ? (
            <>
              <Text style={[styles.value, !onTime(lp.overall) && { color: colors.delay }]}>
                {headline(lp.overall, t)}
              </Text>
              {often ? <Text style={styles.small}>{often}</Text> : null}
            </>
          ) : null}
          {worst ? <Text style={styles.small}>{t('pun.worst', { when: when(worst) })}</Text> : null}
        </View>
      </View>
      {bands.map(([b, e]) => (
        <View key={b}>
          <Divider inset={space.lg} />
          <View style={styles.row} accessible accessibilityLabel={`${when(b)}, ${headline(e, t)}`}>
            <Text style={[styles.band, b === worst && { color: colors.delay }]}>{when(b)}</Text>
            <Text style={[styles.small, onTime(e) ? null : { color: colors.delay }]}>
              {headline(e, t)}
            </Text>
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    intro: {
      ...type.small,
      color: colors.text,
      lineHeight: 19,
      marginBottom: space.md,
      paddingHorizontal: space.lg,
    },
    card: { marginBottom: space.md },
    head: { flexDirection: 'row', gap: space.md, padding: space.lg, alignItems: 'center' },
    value: { ...type.bodyStrong, color: colors.text },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: space.md,
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
    },
    band: { ...type.small, color: colors.text, flexShrink: 1 },
    small: { ...type.small, color: colors.textMuted },
    note: {
      ...type.small,
      color: colors.textFaint,
      lineHeight: 18,
      marginVertical: space.lg,
      paddingHorizontal: space.lg,
    },
  }),
);
