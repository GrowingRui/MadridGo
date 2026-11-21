// The "saved copy" marks: shown wherever an answer comes from the device, not the server.

import { StyleSheet, Text } from 'react-native';

import { useT } from '../i18n';
import { colors, space, themed, type } from '../theme';
import { formatTime } from '../utils/time';
import { Notice } from './layout';

/** A banner for a whole screen (a stop board). */
export function OfflineNotice({ savedAt }: { savedAt: number }) {
  const { t } = useT();
  return (
    <Notice tone="info" icon="cloud-off-outline" title={t('offline.title')}>
      {t('offline.body', { time: formatTime(savedAt) })}
    </Notice>
  );
}

/** One line inside a card (a saved route). */
export function OfflineLine({ savedAt }: { savedAt: number }) {
  const { t } = useT();
  return (
    <Text style={styles.line} accessibilityLiveRegion="polite">
      {t('offline.short', { time: formatTime(savedAt) })}
    </Text>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    line: { ...type.small, color: colors.warning, paddingHorizontal: space.lg, paddingVertical: space.sm },
  }),
);
