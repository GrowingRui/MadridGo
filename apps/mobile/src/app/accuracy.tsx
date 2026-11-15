// How accurate live times have been (GET /accuracy, RELIABILITY_STRATEGY.md §4): for each
// horizon (30 … 2 min before), the share of arrivals within 2 min of the time shown, with the
// 1 and 5 min shares, the usual gap and the average direction; then the timetable alone for
// comparison. Opens from More and About. Renfe Cercanías only for now.

import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  ALL_LINES,
  type AccuracyReport,
  type AccuracyRow,
  biasDirection,
  formatPct,
  formatSeconds,
  getAccuracy,
  liveRows,
  MIN_ROW,
  PERIODS,
  type Period,
  timetableRow,
} from '../api/accuracy';
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
} from '../components/layout';
import { LinePill } from '../components/transit';
import { type PressState, useAsync, useIsWide } from '../hooks';
import { type MessageKey, tn, useT } from '../i18n';
import { colors, radius, space, themed, type } from '../theme';
import { formatIsoDate } from '../utils/time';

export default function AccuracyScreen() {
  const { t } = useT();
  const isWide = useIsWide();
  const [days, setDays] = useState<Period>(7);
  const [line, setLine] = useState(ALL_LINES);
  const { data, error, loading, reload } = useAsync(() => getAccuracy(days), `acc:${days}`);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));

  const subtitle = data
    ? data.first_day === data.last_day
      ? t('acc.subtitleDay', { operator: data.operator_name, day: formatIsoDate(data.last_day) })
      : t('acc.subtitle', {
          operator: data.operator_name,
          from: formatIsoDate(data.first_day),
          to: formatIsoDate(data.last_day),
        })
    : undefined;

  return (
    <Screen
      refreshing={loading && !!data}
      onRefresh={reload}
      header={
        <BrandHeader title={t('acc.title')} subtitle={subtitle} onBack={isWide ? undefined : back}>
          <View style={styles.tabs} accessibilityRole="tablist">
            {PERIODS.map((p) => {
              const active = p === days;
              return (
                <Pressable
                  key={p}
                  onPress={() => setDays(p)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  style={({ pressed, hovered }: PressState) => [
                    styles.tab,
                    active && styles.tabActive,
                    !active && (pressed || hovered) && styles.tabHover,
                  ]}>
                  <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
                    {t(`acc.period.${p}` as MessageKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </BrandHeader>
      }>
      {!data && loading ? <Loading /> : null}
      {!data && error ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? <Report data={data} line={line} onLine={setLine} /> : null}
    </Screen>
  );
}

function Report({
  data,
  line,
  onLine,
}: {
  data: AccuracyReport;
  line: string;
  onLine: (l: string) => void;
}) {
  const { t } = useT();
  const live = liveRows(data, line, false);
  const est = liveRows(data, line, true);
  const timetable = timetableRow(data, line);
  const empty = !data.rows.some((r) => r.line === ALL_LINES);

  return (
    <View>
      <Text style={styles.intro}>{t('acc.intro')}</Text>
      {data.provisional ? (
        <Notice tone="info" icon="flask-outline" title={t('acc.provisional')}>
          {t('acc.provisionalBody', {
            days: data.days_with_data,
            min: data.min_days,
            sample: data.min_sample,
          })}
        </Notice>
      ) : null}

      {empty ? (
        <EmptyState icon="chart-box-outline" title={t('acc.none')} body={t('acc.noneBody')} />
      ) : (
        <>
          {data.lines.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              accessibilityRole="radiogroup"
              accessibilityLabel={t('acc.lineFilter')}
              contentContainerStyle={styles.chips}>
              <Chip
                on={line === ALL_LINES}
                onPress={() => onLine(ALL_LINES)}
                label={t('acc.allLines')}>
                <Text style={styles.chipText}>{t('acc.allLines')}</Text>
              </Chip>
              {data.lines.map((l) => (
                <Chip
                  key={l.short_name}
                  on={line === l.short_name}
                  onPress={() => onLine(l.short_name)}
                  label={l.short_name}>
                  <LinePill line={l} size="sm" />
                </Chip>
              ))}
            </ScrollView>
          ) : null}

          {live.length + est.length === 0 && !timetable ? (
            <Text style={styles.note}>{t('acc.noLine')}</Text>
          ) : null}
          <Section title={t('acc.live')} body={t('acc.liveBody')} rows={live} />
          <Section title={t('acc.est')} body={t('acc.estBody')} rows={est} />
          {timetable ? (
            <Section
              title={t('acc.timetable')}
              body={t('acc.timetableBody')}
              rows={[timetable]}
            />
          ) : null}
        </>
      )}
      <Text style={styles.note}>{t('acc.method')}</Text>
    </View>
  );
}

function Chip({
  on,
  onPress,
  label,
  children,
}: {
  on: boolean;
  onPress: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      style={({ pressed, hovered }: PressState) => [
        styles.chip,
        on && styles.chipOn,
        !on && (pressed || hovered) && { backgroundColor: colors.pressed },
      ]}>
      {children}
    </Pressable>
  );
}

function Section({ title, body, rows }: { title: string; body: string; rows: AccuracyRow[] }) {
  if (rows.length === 0) return null;
  return (
    <View>
      <SectionTitle>{title}</SectionTitle>
      <Text style={styles.sectionBody}>{body}</Text>
      <Card>
        {rows.map((r, i) => (
          <View key={`${r.horizon_min}-${r.estimated}`}>
            {i > 0 ? <Divider inset={space.lg} /> : null}
            <Row r={r} />
          </View>
        ))}
      </Card>
    </View>
  );
}

/** One horizon: label and count on the left; on the right the share within 2 min as text and
 * as a bar, then the other figures. Every number is in the text; the bar only shows it. */
function Row({ r }: { r: AccuracyRow }) {
  const { t } = useT();
  const label = r.horizon_min === null ? t('acc.timetableRow') : t('acc.before', { n: r.horizon_min });
  const count = tn('acc.arrivals', r.n);
  if (r.n < MIN_ROW) {
    return (
      <View style={styles.row}>
        <View style={styles.left}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.small}>{count}</Text>
        </View>
        <Text style={[styles.small, styles.right]}>{t('acc.tooFew')}</Text>
      </View>
    );
  }
  const dir = biasDirection(r.bias_s);
  const avg = dir === 'onTime' ? t('acc.onTime') : t(`acc.${dir}`, { t: formatSeconds(r.bias_s) });
  return (
    <View style={styles.row} accessible>
      <View style={styles.left}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.small}>{count}</Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.value}>{t('acc.within2', { pct: formatPct(r.pct_2m) })}</Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(r.pct_2m * 100)}%` }]} />
        </View>
        <Text style={styles.small}>
          {t('acc.within', { p1: formatPct(r.pct_1m), p5: formatPct(r.pct_5m) })}
        </Text>
        <Text style={styles.small}>
          {`${t('acc.typical', { t: formatSeconds(r.median_abs_s) })} · ${avg}`}
        </Text>
      </View>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.headerDark,
    borderRadius: radius.pill,
    padding: 4,
    marginTop: space.md,
  },
  tab: {
    flexGrow: 1,
    flexShrink: 1,
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
  },
  tabActive: { backgroundColor: colors.surface },
  tabHover: { backgroundColor: 'rgba(255,255,255,0.08)' },
  tabText: { ...type.smallStrong, color: colors.onBrandMuted },
  tabTextActive: { color: colors.brand, fontWeight: '700' },
  intro: { ...type.small, color: colors.text, lineHeight: 19, marginBottom: space.md },
  chips: { gap: space.sm, paddingVertical: space.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { borderColor: colors.brand, borderWidth: 2, backgroundColor: colors.brandTint },
  chipText: { ...type.smallStrong, color: colors.text },
  sectionBody: { ...type.small, color: colors.textMuted, marginBottom: space.sm },
  row: { flexDirection: 'row', gap: space.md, padding: space.lg, alignItems: 'flex-start' },
  left: { width: 104, gap: 2 },
  right: { flex: 1, gap: 4 },
  label: { ...type.bodyStrong, color: colors.text },
  value: { ...type.bodyStrong, color: colors.text },
  small: { ...type.small, color: colors.textMuted },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.divider, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4, backgroundColor: colors.brand },
  note: { ...type.small, color: colors.textFaint, lineHeight: 18, marginVertical: space.lg },
}));
