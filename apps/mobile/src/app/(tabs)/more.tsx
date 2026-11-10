// More: data status (which timetables are active, which expired), backend status, attribution.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchHealth, getApiBaseUrl } from '../../api/health';
import { type FeedStatus, feedStatuses } from '../../api/stops';
import {
  BrandHeader,
  Card,
  Divider,
  ErrorState,
  Loading,
  Screen,
  SectionTitle,
} from '../../components/layout';
import { type PressState, useAsync } from '../../hooks';
import { type LangPreference, setLanguagePreference, useLanguage, useT } from '../../i18n';
import { colors, space, type } from '../../theme';
import { formatIsoDate } from '../../utils/time';

const EXPIRY = {
  ok: { color: colors.live, icon: 'check-circle' },
  expiring: { color: colors.warning, icon: 'alert-circle' },
  expired: { color: colors.delay, icon: 'close-circle' },
} as const;

export default function MoreScreen() {
  const { t } = useT();
  const feeds = useAsync(feedStatuses, 'feeds');
  const health = useAsync(() => fetchHealth(), 'health');
  const refresh = () => {
    feeds.reload();
    health.reload();
  };

  const h = health.data;
  const healthLabel =
    h?.kind === 'healthy'
      ? t('more.healthy')
      : h?.kind === 'degraded'
        ? t('more.degraded')
        : h
          ? t('more.unreachable')
          : '…';
  const healthColor =
    h?.kind === 'healthy' ? colors.live : h?.kind === 'degraded' ? colors.warning : colors.delay;

  return (
    <Screen
      header={<BrandHeader title={t('more.title')} />}
      refreshing={feeds.loading || health.loading}
      onRefresh={refresh}>
      <SectionTitle>{t('more.language')}</SectionTitle>
      <LanguagePicker />

      <SectionTitle>{t('more.timetables')}</SectionTitle>
      {feeds.loading && !feeds.data ? (
        <Loading />
      ) : feeds.error ? (
        <ErrorState message={feeds.error} onRetry={feeds.reload} />
      ) : (
        <Card>
          {feeds.data?.map((f, i) => (
            <View key={f.source}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <FeedRow f={f} />
            </View>
          ))}
        </Card>
      )}

      <SectionTitle>{t('more.service')}</SectionTitle>
      <Card>
        <View style={styles.row}>
          <MaterialCommunityIcons name="server" size={20} color={healthColor} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{t('more.server')}</Text>
            <Text style={styles.small}>{getApiBaseUrl()}</Text>
          </View>
          <Text style={[styles.status, { color: healthColor }]}>{healthLabel}</Text>
        </View>
      </Card>

      <SectionTitle>{t('more.about')}</SectionTitle>
      <Card>
        <View style={[styles.row, { alignItems: 'flex-start' }]}>
          <View style={{ flex: 1, gap: space.sm }}>
            <Text style={styles.body}>{t('more.aboutBody')}</Text>
            <Link label="Powered by CRTM" url="https://www.crtm.es" />
            <Link label="Powered by EMT de Madrid" url="https://www.emtmadrid.es" />
            <Link label={t('attr.renfe')} url="https://data.renfe.com" />
            <Link label={t('attr.osmMap')} url="https://www.openstreetmap.org/copyright" />
          </View>
        </View>
      </Card>
      <Text style={styles.footer}>{t('footer.independent')}</Text>
    </Screen>
  );
}

/** Device language (default), Español or English. Stored on this device only. */
function LanguagePicker() {
  const { t } = useT();
  const { preference } = useLanguage();
  const options: { value: LangPreference; label: string }[] = [
    { value: 'system', label: t('more.languageSystem') },
    { value: 'es', label: 'Español' },
    { value: 'en', label: 'English' },
  ];
  return (
    <Card>
      <View accessibilityRole="radiogroup" accessibilityLabel={t('more.language')}>
        {options.map((o, i) => {
          const on = o.value === preference;
          return (
            <View key={o.value}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Pressable
                onPress={() => setLanguagePreference(o.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={({ pressed, hovered }: PressState) => [
                  styles.row,
                  (pressed || hovered) && { backgroundColor: '#F7F8FA' },
                ]}>
                <MaterialCommunityIcons
                  name={on ? 'radiobox-marked' : 'radiobox-blank'}
                  size={22}
                  color={on ? colors.brand : colors.textFaint}
                />
                <Text style={[styles.title, { flex: 1 }]}>{o.label}</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

function FeedRow({ f }: { f: FeedStatus }) {
  const { t } = useT();
  const e = f.expiry ? EXPIRY[f.expiry] : null;
  return (
    <View style={styles.row}>
      <MaterialCommunityIcons
        name={e?.icon ?? 'help-circle-outline'}
        size={20}
        color={e?.color ?? colors.textFaint}
      />
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{f.operator}</Text>
        <Text style={styles.small}>
          {f.imported
            ? t('feed.validUntil', { date: f.service_end ? formatIsoDate(f.service_end) : '?' }) +
              (f.days_left != null && f.days_left >= 0
                ? t('feed.daysLeft', { n: f.days_left })
                : '')
            : t('feed.notImported')}
        </Text>
      </View>
      <Text style={[styles.status, { color: e?.color ?? colors.textMuted }]}>
        {f.expiry ? t(`expiry.${f.expiry}`) : t('expiry.missing')}
      </Text>
    </View>
  );
}

function Link({ label, url }: { label: string; url: string }) {
  return (
    <Text style={styles.link} accessibilityRole="link" onPress={() => void Linking.openURL(url)}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  title: { ...type.bodyStrong, color: colors.text },
  small: { ...type.small, color: colors.textMuted },
  status: { ...type.smallStrong },
  body: { ...type.small, color: colors.text, lineHeight: 19 },
  link: { ...type.smallStrong, color: colors.brand },
  footer: { ...type.small, color: colors.textFaint, textAlign: 'center', margin: space.lg },
});
