// More: data status (which timetables are active, which expired), backend status, attribution.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Linking, StyleSheet, Text, View } from 'react-native';

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
import { useAsync } from '../../hooks';
import { colors, space, type } from '../../theme';

const EXPIRY = {
  ok: { label: 'Up to date', color: colors.live, icon: 'check-circle' },
  expiring: { label: 'Expires soon', color: colors.warning, icon: 'alert-circle' },
  expired: { label: 'Expired', color: colors.delay, icon: 'close-circle' },
} as const;

export default function MoreScreen() {
  const feeds = useAsync(feedStatuses, 'feeds');
  const health = useAsync(() => fetchHealth(), 'health');
  const refresh = () => {
    feeds.reload();
    health.reload();
  };

  const h = health.data;
  const healthLabel =
    h?.kind === 'healthy'
      ? 'All systems OK'
      : h?.kind === 'degraded'
        ? 'Degraded'
        : h
          ? 'Unreachable'
          : '…';
  const healthColor =
    h?.kind === 'healthy' ? colors.live : h?.kind === 'degraded' ? colors.warning : colors.delay;

  return (
    <Screen
      header={<BrandHeader title="More" />}
      refreshing={feeds.loading || health.loading}
      onRefresh={refresh}>
      <SectionTitle>Timetable data</SectionTitle>
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

      <SectionTitle>Service status</SectionTitle>
      <Card>
        <View style={styles.row}>
          <MaterialCommunityIcons name="server" size={20} color={healthColor} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>MadridGo server</Text>
            <Text style={styles.small}>{getApiBaseUrl()}</Text>
          </View>
          <Text style={[styles.status, { color: healthColor }]}>{healthLabel}</Text>
        </View>
      </Card>

      <SectionTitle>About the data</SectionTitle>
      <Card>
        <View style={[styles.row, { alignItems: 'flex-start' }]}>
          <View style={{ flex: 1, gap: space.sm }}>
            <Text style={styles.body}>
              MadridGo uses open data. Times are labelled Live (real-time feed), Scheduled (official
              timetable) or Every ~N min (the operator only publishes a frequency).
            </Text>
            <Link label="Powered by CRTM" url="https://www.crtm.es" />
            <Link label="Powered by EMT de Madrid" url="https://www.emtmadrid.es" />
            <Link label="Renfe open data (CC BY 4.0)" url="https://data.renfe.com" />
            <Link
              label="Map data © OpenStreetMap contributors"
              url="https://www.openstreetmap.org/copyright"
            />
          </View>
        </View>
      </Card>
      <Text style={styles.footer}>
        MadridGo is independent and not endorsed by CRTM, EMT or Renfe.
      </Text>
    </Screen>
  );
}

function FeedRow({ f }: { f: FeedStatus }) {
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
            ? `Valid until ${f.service_end ?? '?'}${f.days_left != null && f.days_left >= 0 ? ` · ${f.days_left} days left` : ''}`
            : 'Not imported yet'}
        </Text>
      </View>
      <Text style={[styles.status, { color: e?.color ?? colors.textMuted }]}>
        {e?.label ?? 'Missing'}
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
