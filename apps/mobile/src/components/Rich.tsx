// A translated sentence with styled words in it: "{live} times come from…" where {live} is a
// green, bold "Live". The word order stays the translator's, not the code's.

import { Fragment, type ReactNode } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

import { type MessageKey, splitSlots, useT } from '../i18n';

export function Rich({
  k,
  slots,
  style,
}: {
  k: MessageKey;
  slots: Record<string, ReactNode>;
  style?: StyleProp<TextStyle>;
}) {
  const { t } = useT();
  return (
    <Text style={style}>
      {splitSlots(t(k)).map((p, i) => (
        <Fragment key={i}>{'slot' in p ? (slots[p.slot] ?? `{${p.slot}}`) : p.text}</Fragment>
      ))}
    </Text>
  );
}
