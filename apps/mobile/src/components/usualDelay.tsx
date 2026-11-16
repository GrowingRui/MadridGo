// "Usually ~4 min late": how late a Cercanías train usually is, from past days (DB
// Navigator's punctuality info). Shown only while the train has no live time; the server
// leaves it out next to a live one (services/api/app/realtime/usual.py).

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import type { UsualDelay } from '../api/stops';
import { useT } from '../i18n';
import { colors, space, themed, type } from '../theme';

/** 0 or 1 minute counts as on time. */
export function usuallyOnTime(u: UsualDelay): boolean {
  return u.minutes <= 1;
}

export function UsualDelayNote({
  usual,
  style,
}: {
  usual: UsualDelay | null | undefined;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useT();
  if (!usual) return null;
  const onTime = usuallyOnTime(usual);
  const text = onTime ? t('usual.onTime') : t('usual.late', { n: usual.minutes });
  const often =
    !onTime || usual.often_minutes > 1 ? t('usual.a11yOften', { n: usual.often_minutes }) : '';
  return (
    <View style={[styles.line, style]} accessible accessibilityLabel={`${text}${often}`}>
      <MaterialCommunityIcons
        name="history"
        size={14}
        color={onTime ? colors.textMuted : colors.delay}
      />
      <Text style={[styles.text, !onTime && { color: colors.delay }]}>{text}</Text>
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    line: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: 2 },
    text: { ...type.small, color: colors.textMuted },
  }),
);
