// Step-free travel pictograms, as SBB Mobile shows them: a small square with a wheelchair,
// struck through when a wheelchair user cannot board or get off. Shown only when
// "Show step-free travel" is on in Settings (off by default, as in SBB), and only where
// there is information (Cercanías; see utils/access.ts).

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { useT } from '../i18n';
import { useSettings } from '../state/settings';
import { colors, space, themed, type } from '../theme';

/** The pictogram alone. `label` is read by screen readers. */
export function AccessIcon({
  ok,
  size = 18,
  label,
}: {
  ok: boolean;
  size?: number;
  label?: string;
}) {
  return (
    <View
      accessible={!!label}
      accessibilityLabel={label}
      style={[
        styles.square,
        { width: size, height: size, backgroundColor: ok ? colors.brand : colors.textMuted },
      ]}>
      <MaterialCommunityIcons
        name="wheelchair-accessibility"
        size={size - 4}
        color={colors.surface}
      />
      {ok ? null : (
        <View
          style={[styles.strike, { width: size * 1.3, top: size / 2 - 1.25, left: -size * 0.15 }]}
        />
      )}
    </View>
  );
}

/** The pictogram with a short text, e.g. "Step-free boarding". Nothing when unknown or off. */
export function AccessLine({
  ok,
  yes,
  no,
  style,
}: {
  ok: boolean | null | undefined;
  yes: string;
  no: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { stepFree } = useSettings();
  if (!stepFree || ok == null) return null;
  const text = ok ? yes : no;
  return (
    <View style={[styles.line, style]} accessible accessibilityLabel={text}>
      <AccessIcon ok={ok} size={16} />
      <Text style={[styles.text, !ok && { color: colors.delay }]}>{text}</Text>
    </View>
  );
}

/** The pictogram alone, for a list row, when the setting is on and the answer known. */
export function AccessMark({ ok, size }: { ok: boolean | null | undefined; size?: number }) {
  const { t } = useT();
  const { stepFree } = useSettings();
  if (!stepFree || ok == null) return null;
  return (
    <AccessIcon ok={ok} size={size} label={t(ok ? 'access.stepFree' : 'access.notStepFree')} />
  );
}

const styles = themed(() =>
  StyleSheet.create({
    square: {
      borderRadius: 3,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    strike: {
      position: 'absolute',
      height: 2.5,
      backgroundColor: colors.delay,
      transform: [{ rotate: '-45deg' }],
    },
    line: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: 2 },
    text: { ...type.small, color: colors.textMuted },
  }),
);
