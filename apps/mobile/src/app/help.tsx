// Help and FAQ: short answers to common questions, grouped by topic; tap a question to open
// its answer. Opens from More and the website footer. Ends with contact and About.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { BrandHeader, Card, Divider, Screen, SectionTitle } from '../components/layout';
import { type PressState, useIsWide } from '../hooks';
import { type MessageKey, useT } from '../i18n';
import { colors, space, themed, type } from '../theme';
import { CONTACT_EMAIL } from '../utils/contact';

/** Each question `help.q.<id>` has its answer at `help.a.<id>`. */
const SECTIONS: { title: MessageKey; ids: string[] }[] = [
  { title: 'help.sec.using', ids: ['plan', 'save', 'board', 'disruptions', 'stepFree'] },
  { title: 'help.sec.times', ids: ['labels', 'metro', 'bus45', 'hollow', 'wrong'] },
  { title: 'help.sec.data', ids: ['stored', 'location', 'tickets'] },
];

export default function HelpScreen() {
  const { t } = useT();
  const isWide = useIsWide();
  const [open, setOpen] = useState<string | null>(null);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  const version = Constants.expoConfig?.version ?? '?';

  return (
    <Screen
      header={
        <BrandHeader
          title={t('help.title')}
          subtitle={t('help.subtitle')}
          onBack={isWide ? undefined : back}
        />
      }>
      {SECTIONS.map((s) => (
        <View key={s.title}>
          <SectionTitle>{t(s.title)}</SectionTitle>
          <Card>
            {s.ids.map((id, i) => (
              <View key={id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <Question
                  q={t(`help.q.${id}` as MessageKey)}
                  a={t(`help.a.${id}` as MessageKey)}
                  open={open === id}
                  onToggle={() => setOpen(open === id ? null : id)}
                />
              </View>
            ))}
          </Card>
        </View>
      ))}

      <SectionTitle>{t('help.more')}</SectionTitle>
      <Card>
        <LinkRow
          icon="email-outline"
          title={t('help.contact')}
          detail={CONTACT_EMAIL}
          onPress={() => void Linking.openURL(`mailto:${CONTACT_EMAIL}?subject=MadridGo%20${version}`)}
        />
        <Divider inset={space.lg} />
        <LinkRow
          icon="information-outline"
          title={t('about.link')}
          onPress={() => router.push('/about')}
        />
      </Card>
      <Text style={styles.footer}>{t('footer.independent')}</Text>
    </Screen>
  );
}

function Question({
  q,
  a,
  open,
  onToggle,
}: {
  q: string;
  a: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <View>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed, hovered }: PressState) => [
          styles.row,
          (pressed || hovered) && { backgroundColor: colors.pressed },
        ]}>
        <Text style={[styles.question, { flex: 1 }]}>{q}</Text>
        <MaterialCommunityIcons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={22}
          color={colors.textMuted}
        />
      </Pressable>
      {open ? <Text style={styles.answer}>{a}</Text> : null}
    </View>
  );
}

function LinkRow({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  title: string;
  detail?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={detail ? `${title}: ${detail}` : title}
      style={({ pressed, hovered }: PressState) => [
        styles.row,
        (pressed || hovered) && { backgroundColor: colors.pressed },
      ]}>
      <MaterialCommunityIcons name={icon} size={20} color={colors.brand} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.question}>{title}</Text>
        {detail ? <Text style={styles.link}>{detail}</Text> : null}
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textFaint} />
    </Pressable>
  );
}

const styles = themed(() => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  question: { ...type.bodyStrong, color: colors.text },
  answer: {
    ...type.small,
    color: colors.text,
    lineHeight: 19,
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
  },
  link: { ...type.small, color: colors.brand },
  footer: {
    ...type.small,
    color: colors.textFaint,
    textAlign: 'center',
    margin: space.lg,
    lineHeight: 18,
  },
}));
