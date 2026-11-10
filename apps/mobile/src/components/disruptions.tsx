// Disruptions page pieces (SBB-style "Disruptions"): one card per operator alert with its line
// pictograms, validity and text; the header button with a badge that opens the page; and the
// list of which operators publish alerts.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  type Disruption,
  type Disruptions,
  type DisruptionSource,
  currentLineDisruptions,
  disruptionBody,
  disruptionTitle,
  getDisruptions,
} from '../api/disruptions';
import type { PressState } from '../hooks';
import { tn, useT } from '../i18n';
import { colors, radius, space, type } from '../theme';
import { dayLabel, formatTime } from '../utils/time';
import { LinePills } from './transit';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

// --- Shared data: the page and the header badges use one request, refreshed every 2 min. ----

const MAX_AGE_MS = 120_000;
let cache: { data: Disruptions | null; error: string | null; at: number; loading: boolean } = {
  data: null,
  error: null,
  at: 0,
  loading: false,
};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function load(force = false) {
  if (cache.loading || (!force && Date.now() - cache.at < MAX_AGE_MS)) return;
  cache = { ...cache, loading: true };
  emit();
  getDisruptions()
    .then((data) => {
      cache = { data, error: null, at: Date.now(), loading: false };
    })
    .catch((e: unknown) => {
      // Keep the last list on a failed refresh; retry on the next view.
      cache = { ...cache, error: e instanceof Error ? e.message : String(e), loading: false };
    })
    .finally(emit);
}

export function useDisruptions() {
  const { lang } = useT();
  const state = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => cache,
  );
  useEffect(() => {
    load();
    const timer = setInterval(() => load(), MAX_AGE_MS);
    return () => clearInterval(timer);
  }, []);
  // The server's own messages (sources) come in the app's language.
  useEffect(() => {
    if (cache.at) load(true);
  }, [lang]);
  const reload = useCallback(() => load(true), []);
  return { ...state, reload };
}

// --- Header button ------------------------------------------------------------------------

/** ⚠ in the navy header; an amber badge counts line disruptions in force now. */
export function DisruptionsButton() {
  const { t } = useT();
  const { data } = useDisruptions();
  const n = currentLineDisruptions(data);
  return (
    <Pressable
      onPress={() => router.push('/disruptions')}
      accessibilityRole="button"
      accessibilityLabel={n ? tn('dis.openCount', n) : t('dis.open')}
      hitSlop={10}
      style={({ pressed }) => [styles.headerBtn, pressed && { opacity: 0.7 }]}>
      <MaterialCommunityIcons name="alert-outline" size={24} color={colors.onBrand} />
      {n ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{n > 99 ? '99+' : n}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// --- Card ---------------------------------------------------------------------------------

type T = ReturnType<typeof useT>['t'];

/** "today 06:28" inside a sentence, but "Mon 09.11. 11:23" as is. */
function when(iso: string, now: number, t: T): string {
  const at = Date.parse(iso);
  const day = dayLabel(at, now);
  const word = day === t('time.today') || day === t('time.tomorrow');
  return `${word ? day.toLocaleLowerCase() : day} ${formatTime(at)}`;
}

/** "Since Mon 09.11. 18:23", "From tomorrow 08:00", "Today 20:00 – 22:30". */
export function validityText(d: Disruption, now: number, t: T) {
  const from = d.active_from;
  const to = d.active_to;
  if (from && to) {
    const sameDay = dayLabel(Date.parse(from), now) === dayLabel(Date.parse(to), now);
    const start = `${dayLabel(Date.parse(from), now)} ${formatTime(Date.parse(from))}`;
    return t('dis.range', {
      from: start,
      to: sameDay ? formatTime(Date.parse(to)) : when(to, now, t),
    });
  }
  if (from) return t(d.upcoming ? 'dis.from' : 'dis.since', { when: when(from, now, t) });
  if (to) return t('dis.until', { when: when(to, now, t) });
  return null;
}

const LONG_TEXT = 220; // characters of body text shown before "Show more"
const LONG_TITLE = 140; // a Renfe first sentence this long is clipped to 3 lines

export function DisruptionCard({ d, now }: { d: Disruption; now: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const title = disruptionTitle(d);
  const body = disruptionBody(d);
  const longTitle = title.length > LONG_TITLE;
  const long = longTitle || (!!body && body.length > LONG_TEXT);
  const validity = validityText(d, now, t);
  const icon: IconName =
    d.kind === 'station' ? 'elevator-passenger-outline' : d.upcoming ? 'calendar-clock' : 'alert';
  const tint = d.upcoming || d.kind === 'station' ? colors.textMuted : colors.warning;
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <MaterialCommunityIcons name={icon} size={20} color={tint} style={styles.cardIcon} />
        <View style={{ flex: 1, gap: space.xs }}>
          {d.lines.length ? <LinePills lines={d.lines} max={10} /> : null}
          {d.kind === 'station'
            ? d.stations.map((s) =>
                s.id ? (
                  <Pressable
                    key={s.id}
                    onPress={() =>
                      router.push({ pathname: '/stop/[id]', params: { id: s.id as string } })
                    }
                    accessibilityRole="link"
                    accessibilityLabel={t('dis.openBoard', { name: s.name })}
                    style={({ hovered }: PressState) => [hovered && { opacity: 0.7 }]}>
                    <Text style={styles.station}>
                      {s.name}{' '}
                      <MaterialCommunityIcons name="chevron-right" size={14} color={colors.brand} />
                    </Text>
                  </Pressable>
                ) : (
                  <Text key={s.name} style={[styles.station, { color: colors.text }]}>
                    {s.name}
                  </Text>
                ),
              )
            : null}
          <Text style={styles.cardTitle} numberOfLines={longTitle && !open ? 3 : undefined}>
            {title}
          </Text>
          <View style={styles.metaRow}>
            {d.upcoming ? (
              <View style={styles.upcoming}>
                <Text style={styles.upcomingText}>{t('dis.upcoming')}</Text>
              </View>
            ) : null}
            {validity ? <Text style={styles.meta}>{validity}</Text> : null}
          </View>
          {body ? (
            <Text
              style={styles.body}
              numberOfLines={long && !open ? (longTitle ? 2 : 4) : undefined}>
              {body}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {long ? (
              <Text style={styles.link} onPress={() => setOpen(!open)} accessibilityRole="button">
                {t(open ? 'dis.showLess' : 'dis.showMore')}
              </Text>
            ) : null}
            {d.url ? (
              <Text
                style={styles.link}
                onPress={() => void Linking.openURL(d.url as string)}
                accessibilityRole="link">
                {t('dis.moreInfo')}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

// --- Coverage -----------------------------------------------------------------------------

const SOURCE_STYLE: Record<DisruptionSource['state'], { icon: IconName; fg: string }> = {
  ok: { icon: 'check-circle-outline', fg: colors.live },
  stale: { icon: 'clock-alert-outline', fg: colors.warning },
  no_data: { icon: 'cloud-off-outline', fg: colors.delay },
  not_available: { icon: 'minus-circle-outline', fg: colors.textMuted },
};

export function SourcesCard({ sources }: { sources: DisruptionSource[] }) {
  const { t } = useT();
  return (
    <View style={[styles.card, { gap: space.md }]}>
      {sources.map((s) => {
        const st = SOURCE_STYLE[s.state];
        return (
          <View key={s.operator} style={styles.source}>
            <MaterialCommunityIcons name={st.icon} size={20} color={st.fg} />
            <View style={{ flex: 1 }}>
              <Text style={type.bodyStrong}>
                {s.name}
                <Text style={[type.small, { color: st.fg }]}>
                  {'  '}
                  {t(`dis.state.${s.state}`)}
                </Text>
              </Text>
              {s.state === 'ok' ? null : <Text style={styles.meta}>{s.message}</Text>}
            </View>
          </View>
        );
      })}
      <Text style={styles.meta}>{t('dis.coverageNote')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headerBtn: { padding: 2 },
  badge: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.brand,
  },
  badgeText: { fontSize: 10, fontWeight: '800', color: colors.brandDark },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
  },
  cardTop: { flexDirection: 'row', gap: space.md },
  cardIcon: { marginTop: 2 },
  cardTitle: { ...type.bodyStrong, color: colors.text },
  station: { ...type.bodyStrong, color: colors.brand },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  meta: { ...type.small, color: colors.textMuted },
  upcoming: {
    backgroundColor: colors.brandTint,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  upcomingText: { ...type.smallStrong, color: colors.brand },
  body: { ...type.small, color: colors.text, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: space.lg },
  link: { ...type.smallStrong, color: colors.brand, paddingVertical: 2 },
  source: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
});
