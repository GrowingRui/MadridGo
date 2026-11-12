// The card under the live trip map when it follows an EMT bus: the line and direction, how far
// and how soon ("Bus arrives in 4 min · 1.2 km away", "2.3 km to Plaza Castilla"), where it
// comes from (Live · EMT, updated 15 s ago), and where you board and get off, with times.

import { StyleSheet, Text, View } from 'react-native';

import type { BusPosition } from '../api/buses';
import type { Leg } from '../api/journeys';
import { useT } from '../i18n';
import { colors, space, themed, type } from '../theme';
import { busSourceText, busText, isBusShown } from '../utils/busPosition';
import { formatTime } from '../utils/time';
import { LinePill, StatusBadge, TimeWithDelay } from './transit';

export function LiveBusCard({ leg, pos, now }: { leg: Leg; pos: BusPosition | null; now: number }) {
  const { t } = useT();
  // The position, when recent enough to show.
  const shown = pos && isBusShown(pos, now) ? pos : null;
  let main: string;
  if (shown) main = busText(shown, leg, now);
  else if (pos?.status === 'unavailable' && pos.message) main = pos.message;
  else main = t('bus.looking');
  const riding = shown?.status === 'riding';
  const live = (at: string | null | undefined) =>
    at ? <Text style={styles.time}>{formatTime(at)}</Text> : null;

  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.inner}>
        <View style={styles.top}>
          {leg.line ? <LinePill line={leg.line} /> : null}
          {leg.headsign ? (
            <Text style={styles.direction} numberOfLines={1}>
              {t('conn.direction', { name: leg.headsign })}
            </Text>
          ) : null}
          {shown ? <StatusBadge status="live" /> : null}
        </View>
        <Text style={styles.main}>{main}</Text>
        {shown ? <Text style={styles.small}>{busSourceText(shown, now)}</Text> : null}
        <View style={styles.rows}>
          {riding ? null : (
            <Row
              label={t('liveMap.board', { stop: leg.from })}
              right={
                shown?.expected_at ? (
                  live(shown.expected_at)
                ) : (
                  <TimeWithDelay time={leg.departure} />
                )
              }
            />
          )}
          <Row
            label={t('liveMap.getOff', { stop: leg.to })}
            right={
              riding && shown?.expected_at ? (
                live(shown.expected_at)
              ) : (
                <TimeWithDelay time={leg.arrival} />
              )
            }
          />
        </View>
      </View>
    </View>
  );
}

function Row({ label, right }: { label: string; right: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel} numberOfLines={2}>
        {label}
      </Text>
      {right}
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: space.lg,
      paddingTop: space.md,
      paddingBottom: space.lg,
    },
    // On the website: a readable width, centred under the map.
    inner: { width: '100%', maxWidth: 720, alignSelf: 'center', gap: space.xs },
    top: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    direction: { ...type.bodyStrong, color: colors.text, flexShrink: 1 },
    main: { ...type.bodyStrong, color: colors.text, marginTop: space.xs },
    small: { ...type.small, color: colors.textMuted },
    rows: { marginTop: space.sm, gap: space.xs },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.md,
    },
    rowLabel: { ...type.body, color: colors.text, flexShrink: 1 },
    time: { ...type.timeL, color: colors.text },
  }),
);
