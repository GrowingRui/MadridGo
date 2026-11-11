// About MadridGo: what the reliability labels mean, which modes have live data today, every
// data source with its licence and the attribution its terms ask for ("Powered by CRTM",
// "Powered by EMT de Madrid", Renfe CC BY 4.0, © OpenStreetMap contributors), the
// independence note, privacy in short, contact and version. Opens from More and the
// website footer.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { BrandHeader, Card, Divider, Screen, SectionTitle } from '../components/layout';
import { StatusBadge } from '../components/transit';
import { type PressState, useIsWide } from '../hooks';
import { type MessageKey, useT } from '../i18n';
import { colors, radius, space, themed, type } from '../theme';
import { CONTACT_EMAIL } from '../utils/contact';

type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

/** Each source with the credit line its terms ask for, and its licence page. */
const SOURCES: { credit: string | MessageKey; what: MessageKey; url: string; licence?: string }[] = [
  {
    credit: 'Powered by CRTM',
    what: 'about.src.crtm',
    url: 'https://www.crtm.es',
    licence: 'https://www.crtm.es/licencia-de-uso',
  },
  {
    credit: 'Powered by EMT de Madrid',
    what: 'about.src.emt',
    url: 'https://www.emtmadrid.es',
    licence: 'https://mobilitylabs.emtmadrid.es',
  },
  {
    credit: 'attr.renfe',
    what: 'about.src.renfe',
    url: 'https://data.renfe.com',
    licence: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    credit: 'attr.osm',
    what: 'about.src.osm',
    url: 'https://www.openstreetmap.org',
    licence: 'https://www.openstreetmap.org/copyright',
  },
  { credit: 'OpenFreeMap', what: 'about.src.openfreemap', url: 'https://openfreemap.org' },
  { credit: 'MapLibre', what: 'about.src.maplibre', url: 'https://maplibre.org' },
  { credit: 'OpenTripPlanner', what: 'about.src.otp', url: 'https://www.opentripplanner.org' },
];

const COVERAGE: { icon: IconName; text: MessageKey; live: boolean }[] = [
  { icon: 'train', text: 'about.cov.rail', live: true },
  { icon: 'bus', text: 'about.cov.emt', live: false },
  { icon: 'subway-variant', text: 'about.cov.metro', live: false },
  { icon: 'bus-side', text: 'about.cov.crtm', live: false },
];

export default function AboutScreen() {
  const { t } = useT();
  const isWide = useIsWide();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  const version = Constants.expoConfig?.version ?? '?';
  const open = (url: string) => () => void Linking.openURL(url);

  return (
    <Screen
      header={
        <BrandHeader
          title={t('about.title')}
          subtitle={t('about.version', { v: version })}
          onBack={isWide ? undefined : back}
        />
      }>
      <Card>
        <View style={styles.block}>
          <Text style={styles.body}>{t('about.intro')}</Text>
        </View>
      </Card>

      <SectionTitle>{t('about.labels')}</SectionTitle>
      <Card>
        <LabelRow badge={<StatusBadge status="live" />} text={t('about.label.live')} />
        <Divider inset={space.lg} />
        <LabelRow badge={<StatusBadge status="scheduled" />} text={t('about.label.scheduled')} />
        <Divider inset={space.lg} />
        <LabelRow
          badge={<StatusBadge status="frequency" text={t('status.everyGeneric')} />}
          text={t('about.label.every')}
        />
        <Divider inset={space.lg} />
        <LabelRow
          badge={
            <View style={styles.pointRow}>
              <View style={styles.hollowPoint} />
              <Text style={styles.titleSmall}>{t('about.label.estimated')}</Text>
            </View>
          }
          text={t('about.label.estimatedBody')}
        />
        <Divider inset={space.lg} />
        <LabelRow
          badge={
            <Text style={[styles.titleSmall, { color: colors.textMuted }]}>
              {t('about.label.outdated')}
            </Text>
          }
          text={t('about.label.outdatedBody')}
        />
      </Card>

      <SectionTitle>{t('about.coverage')}</SectionTitle>
      <Card>
        {COVERAGE.map((c, i) => (
          <View key={c.text}>
            {i > 0 ? <Divider inset={space.lg} /> : null}
            <View style={styles.row}>
              <MaterialCommunityIcons
                name={c.icon}
                size={20}
                color={c.live ? colors.live : colors.textMuted}
              />
              <Text style={[styles.body, { flex: 1 }]}>{t(c.text)}</Text>
            </View>
          </View>
        ))}
      </Card>

      <SectionTitle>{t('about.sources')}</SectionTitle>
      <Card>
        {SOURCES.map((s, i) => {
          const credit = s.credit.includes('.') ? t(s.credit as MessageKey) : s.credit;
          return (
            <View key={s.url}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <View style={styles.source}>
                <Text style={styles.link} accessibilityRole="link" onPress={open(s.url)}>
                  {credit}
                </Text>
                <Text style={styles.small}>{t(s.what)}</Text>
                {s.licence ? (
                  <Text
                    style={styles.smallLink}
                    accessibilityRole="link"
                    onPress={open(s.licence)}>
                    {t('about.licence')}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </Card>

      <SectionTitle>{t('about.privacy')}</SectionTitle>
      <Card>
        <View style={styles.block}>
          <Text style={styles.body}>{t('about.privacyBody')}</Text>
        </View>
      </Card>

      <SectionTitle>{t('about.contact')}</SectionTitle>
      <Card>
        <Pressable
          onPress={open(`mailto:${CONTACT_EMAIL}?subject=MadridGo%20${version}`)}
          accessibilityRole="link"
          accessibilityLabel={`${t('about.contact')}: ${CONTACT_EMAIL}`}
          style={({ pressed, hovered }: PressState) => [
            styles.row,
            (pressed || hovered) && { backgroundColor: colors.pressed },
          ]}>
          <MaterialCommunityIcons name="email-outline" size={20} color={colors.brand} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.body}>{t('about.contactBody')}</Text>
            <Text style={styles.link}>{CONTACT_EMAIL}</Text>
          </View>
        </Pressable>
      </Card>

      <Text style={styles.footer}>{t('about.independent')}</Text>
    </Screen>
  );
}

function LabelRow({ badge, text }: { badge: ReactNode; text: string }) {
  return (
    <View style={styles.labelRow}>
      <View style={{ alignSelf: 'flex-start' }}>{badge}</View>
      <Text style={styles.body}>{text}</Text>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  block: { padding: space.lg },
  labelRow: { gap: space.sm, padding: space.lg },
  source: { gap: 2, padding: space.lg },
  pointRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  hollowPoint: {
    width: 12,
    height: 12,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.brand,
    backgroundColor: colors.surface,
  },
  titleSmall: { ...type.smallStrong, color: colors.text },
  body: { ...type.small, color: colors.text, lineHeight: 19 },
  small: { ...type.small, color: colors.textMuted, lineHeight: 18 },
  link: { ...type.smallStrong, color: colors.brand },
  smallLink: { ...type.small, color: colors.brand, textDecorationLine: 'underline' },
  footer: {
    ...type.small,
    color: colors.textFaint,
    textAlign: 'center',
    margin: space.lg,
    lineHeight: 18,
  },
}));
