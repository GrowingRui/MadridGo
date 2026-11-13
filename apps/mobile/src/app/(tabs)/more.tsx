// More: settings (language, appearance, location, data on this device), data status
// (which timetables are active, which expired), backend status, attribution.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { fetchHealth, getApiBaseUrl } from '../../api/health';
import { AccessIcon } from '../../components/access';
import { type FeedStatus, feedStatuses } from '../../api/stops';
import {
  BrandHeader,
  Button,
  Card,
  Divider,
  ErrorState,
  Loading,
  Screen,
  SectionTitle,
} from '../../components/layout';
import { type PressState, useAsync } from '../../hooks';
import {
  type LangPreference,
  type MessageKey,
  setLanguagePreference,
  useLanguage,
  useT,
} from '../../i18n';
import { clearConnections, useSavedConnections } from '../../state/connections';
import { clearAllSaved, clearRecents, useSaved } from '../../state/saved';
import {
  type AppearancePreference,
  setAppearance,
  setStepFree,
  useSettings,
} from '../../state/settings';
import { colors, space, themed, type } from '../../theme';
import { formatIsoDate } from '../../utils/time';

const EXPIRY = themed(() => ({
  ok: { color: colors.live, icon: 'check-circle' },
  expiring: { color: colors.warning, icon: 'alert-circle' },
  expired: { color: colors.delay, icon: 'close-circle' },
}) as const);

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

      <SectionTitle>{t('more.appearance')}</SectionTitle>
      <AppearancePicker />

      <SectionTitle>{t('access.section')}</SectionTitle>
      <StepFreeCard />

      <SectionTitle>{t('more.location')}</SectionTitle>
      <LocationCard />

      <SectionTitle>{t('more.data')}</SectionTitle>
      <DataCard />

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
        <Divider inset={space.lg} />
        <Pressable
          onPress={() => router.push('/help')}
          accessibilityRole="link"
          style={({ pressed, hovered }: PressState) => [
            styles.row,
            (pressed || hovered) && { backgroundColor: colors.pressed },
          ]}>
          <MaterialCommunityIcons name="help-circle-outline" size={20} color={colors.brand} />
          <Text style={[styles.title, { flex: 1 }]}>{t('help.link')}</Text>
          <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textFaint} />
        </Pressable>
        <Divider inset={space.lg} />
        <Pressable
          onPress={() => router.push('/about')}
          accessibilityRole="link"
          style={({ pressed, hovered }: PressState) => [
            styles.row,
            (pressed || hovered) && { backgroundColor: colors.pressed },
          ]}>
          <MaterialCommunityIcons name="information-outline" size={20} color={colors.brand} />
          <Text style={[styles.title, { flex: 1 }]}>{t('about.link')}</Text>
          <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textFaint} />
        </Pressable>
      </Card>
      <Text style={styles.footer}>{t('footer.independent')}</Text>
    </Screen>
  );
}

/** Device language (default), Español or English. Stored on this device only. */
function LanguagePicker() {
  const { t } = useT();
  const { preference } = useLanguage();
  return (
    <Choices<LangPreference>
      label={t('more.language')}
      value={preference}
      onChange={setLanguagePreference}
      options={[
        { value: 'system', label: t('more.languageSystem') },
        { value: 'es', label: 'Español' },
        { value: 'en', label: 'English' },
      ]}
    />
  );
}

/** Light (default) or dark. Switching redraws the app at once. */
function AppearancePicker() {
  const { t } = useT();
  const { appearance } = useSettings();
  const options: { value: AppearancePreference; label: MessageKey }[] = [
    { value: 'light', label: 'more.appearanceLight' },
    { value: 'dark', label: 'more.appearanceDark' },
  ];
  return (
    <Choices
      label={t('more.appearance')}
      value={appearance}
      onChange={setAppearance}
      options={options.map((o) => ({ value: o.value, label: t(o.label) }))}
    />
  );
}

/** "Show step-free travel": wheelchair icons, off by default as in SBB Mobile. */
function StepFreeCard() {
  const { t } = useT();
  const { stepFree } = useSettings();
  return (
    <Card>
      <View style={styles.row}>
        <AccessIcon ok size={22} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title}>{t('access.setting')}</Text>
          <Text style={styles.small}>{t('access.settingBody')}</Text>
        </View>
        <Switch
          value={stepFree}
          onValueChange={setStepFree}
          accessibilityLabel={t('access.setting')}
          trackColor={{ true: colors.brand, false: colors.border }}
          thumbColor={colors.surface}
        />
      </View>
    </Card>
  );
}

/** A card of radio rows. */
function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Card>
      <View accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <View key={o.value}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Pressable
                onPress={() => onChange(o.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={({ pressed, hovered }: PressState) => [
                  styles.row,
                  (pressed || hovered) && { backgroundColor: colors.pressed },
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

type Permission = 'granted' | 'denied' | 'undetermined' | 'unknown';

/** Whether the app may use the location; checked again whenever the app comes to the front. */
function useLocationPermission(): Permission {
  const [status, setStatus] = useState<Permission>('unknown');
  const check = useCallback(() => {
    Location.getForegroundPermissionsAsync()
      .then((p) => setStatus(p.status as Permission))
      .catch(() => setStatus('unknown'));
  }, []);
  useEffect(() => {
    check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => sub.remove();
  }, [check]);
  return status;
}

function LocationCard() {
  const { t } = useT();
  const status = useLocationPermission();
  const label = {
    granted: t('more.locationGranted'),
    denied: t('more.locationDenied'),
    undetermined: t('more.locationAsk'),
    unknown: t('more.locationUnknown'),
  }[status];
  const color =
    status === 'granted' ? colors.live : status === 'denied' ? colors.delay : colors.textMuted;
  const web = Platform.OS === 'web';
  return (
    <Card>
      <View style={styles.row}>
        <MaterialCommunityIcons name="crosshairs-gps" size={20} color={color} />
        <Text style={[styles.title, { flex: 1 }]}>{t('more.locationAccess')}</Text>
        <Text style={[styles.status, { color }]}>{label}</Text>
      </View>
      <View style={styles.block}>
        <Text style={styles.body}>
          {status === 'denied'
            ? t(web ? 'more.locationDeniedWeb' : 'more.locationDeniedBody')
            : t('more.locationBody')}
        </Text>
        {status === 'denied' && !web ? (
          <Button
            label={t('more.openSettings')}
            variant="secondary"
            icon="cog-outline"
            onPress={() => void Linking.openSettings()}
          />
        ) : null}
      </View>
    </Card>
  );
}

/** Asks before deleting: a dialog in the app, the browser's confirm box on the website. */
function confirmDelete(message: string, ok: string, cancel: string, run: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(message)) run();
    return;
  }
  Alert.alert(message, undefined, [
    { text: cancel, style: 'cancel' },
    { text: ok, style: 'destructive', onPress: run },
  ]);
}

/** Starred and recent stops and saved connections: how many there are, and buttons to delete them. */
function DataCard() {
  const { t, tn } = useT();
  const { favorites, recents } = useSaved();
  const connections = useSavedConnections();
  return (
    <Card>
      <View style={[styles.block, { paddingTop: space.lg }]}>
        <Text style={styles.body}>
          {t('more.dataBody', {
            starred: tn('more.starred', favorites.length),
            recent: tn('more.recent', recents.length),
            connections: tn('more.connections', connections.length),
          })}
        </Text>
        <Button
          label={t('more.clearRecents')}
          variant="secondary"
          icon="history"
          disabled={recents.length === 0}
          onPress={clearRecents}
        />
        <Button
          label={t('more.clearAll')}
          variant="secondary"
          icon="delete-outline"
          disabled={favorites.length === 0 && recents.length === 0 && connections.length === 0}
          onPress={() =>
            confirmDelete(t('more.clearAllConfirm'), t('more.delete'), t('more.cancel'), () => {
              clearAllSaved();
              clearConnections();
            })
          }
        />
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

const styles = themed(() => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  block: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg },
  title: { ...type.bodyStrong, color: colors.text },
  small: { ...type.small, color: colors.textMuted },
  status: { ...type.smallStrong },
  body: { ...type.small, color: colors.text, lineHeight: 19 },
  link: { ...type.smallStrong, color: colors.brand },
  footer: { ...type.small, color: colors.textFaint, textAlign: 'center', margin: space.lg },
}));
