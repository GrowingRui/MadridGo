// Disruptions page (SBB-style): every current and upcoming Renfe Cercanías and EMT alert, by
// line, with filter tabs and a line/station filter. Opens from the ⚠ button on Plan and
// Departures, and from the website's top navigation.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  type DisruptionFilter,
  type SectionKey,
  groupDisruptions,
  matchesFilter,
} from '../api/disruptions';
import { DisruptionCard, SourcesCard, useDisruptions } from '../components/disruptions';
import {
  BrandHeader,
  EmptyState,
  ErrorState,
  Loading,
  Screen,
  SectionTitle,
} from '../components/layout';
import { useIsWide, useNow, type PressState } from '../hooks';
import { type MessageKey, useT } from '../i18n';
import { colors, radius, space, type } from '../theme';
import { formatTime } from '../utils/time';

const FILTERS: { key: DisruptionFilter; label: MessageKey }[] = [
  { key: 'all', label: 'dis.filter.all' },
  { key: 'rail', label: 'dis.filter.rail' },
  { key: 'bus', label: 'dis.filter.bus' },
  { key: 'stations', label: 'dis.filter.stations' },
];

const SECTION_TITLE: Record<SectionKey, MessageKey> = {
  rail: 'dis.section.rail',
  stations: 'dis.section.stations',
  bus: 'dis.section.bus',
};

export default function DisruptionsScreen() {
  const { t } = useT();
  const isWide = useIsWide();
  const now = useNow(60_000);
  const { data, error, loading, reload } = useDisruptions();
  const [filter, setFilter] = useState<DisruptionFilter>('all');
  const [line, setLine] = useState('');
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const sections = useMemo(
    () => groupDisruptions((data?.disruptions ?? []).filter((d) => matchesFilter(d, filter, line))),
    [data, filter, line],
  );

  return (
    <Screen
      refreshing={loading && !!data}
      onRefresh={reload}
      header={
        <BrandHeader
          title={t('dis.title')}
          subtitle={data ? t('dis.subtitle', { time: formatTime(data.generated_at) }) : undefined}
          onBack={isWide ? undefined : back}>
          <View style={styles.tabs} accessibilityRole="tablist">
            {FILTERS.map((f) => {
              const active = f.key === filter;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setFilter(f.key)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  style={({ pressed, hovered }: PressState) => [
                    styles.tab,
                    active && styles.tabActive,
                    !active && (pressed || hovered) && styles.tabHover,
                  ]}>
                  <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
                    {t(f.label)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.search}>
            <MaterialCommunityIcons name="magnify" size={20} color={colors.textMuted} />
            <TextInput
              value={line}
              onChangeText={setLine}
              placeholder={t('dis.lineFilter')}
              placeholderTextColor={colors.textFaint}
              accessibilityLabel={t('dis.lineFilter')}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.input}
            />
            {line ? (
              <Pressable
                onPress={() => setLine('')}
                accessibilityRole="button"
                accessibilityLabel={t('common.clear')}
                hitSlop={8}>
                <MaterialCommunityIcons name="close-circle" size={18} color={colors.textFaint} />
              </Pressable>
            ) : null}
          </View>
        </BrandHeader>
      }>
      {!data && loading ? <Loading /> : null}
      {!data && error ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? (
        <>
          {sections.length === 0 ? (
            data.disruptions.length === 0 ? (
              <EmptyState
                icon="check-circle-outline"
                title={t('dis.none')}
                body={t('dis.noneBody')}
              />
            ) : (
              <EmptyState icon="filter-off-outline" title={t('dis.noMatch')} />
            )
          ) : (
            sections.map((s) => (
              <View key={s.key}>
                <SectionTitle>{`${t(SECTION_TITLE[s.key])} · ${s.items.length}`}</SectionTitle>
                {s.items.map((d) => (
                  <DisruptionCard key={d.id} d={d} now={now} />
                ))}
              </View>
            ))
          )}
          <SectionTitle>{t('dis.coverage')}</SectionTitle>
          <SourcesCard sources={data.sources} />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.brandDark,
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
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    marginTop: space.md,
  },
  input: { ...type.body, flex: 1, paddingVertical: 10, color: colors.text },
});
