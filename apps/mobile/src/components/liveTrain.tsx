// The card under the live trip map (as in SBB Mobile's "Live" map): the followed train's line
// and direction, where it is now ("Train is 2 stops away", "Now between A and B"), where the
// position comes from (Live · position 20 s ago / Estimated), and the next stop or where you
// board and get off, with times.

import { StyleSheet, Text, View } from 'react-native';

import type { Leg } from '../api/journeys';
import type { TripPosition } from '../api/trips';
import { useT } from '../i18n';
import { colors, space, themed, type } from '../theme';
import { formatTime } from '../utils/time';
import { approachText, place, positionAgeS, ridingText, sourceText } from '../utils/trainPosition';
import { LinePill, StatusBadge, TimeWithDelay } from './transit';

export function LiveTrainCard({
  leg,
  pos,
  now,
}: {
  leg: Leg;
  pos: TripPosition | null;
  now: number;
}) {
  const { t } = useT();
  const placed = pos ? place(pos, leg, now) : ({ kind: 'none' } as const);
  let main: string;
  if (pos && placed.kind === 'approaching') main = approachText(placed);
  else if (pos && placed.kind === 'riding') main = ridingText(pos, placed.at);
  else if (pos?.status === 'unavailable' && pos.message) main = pos.message;
  else main = t('liveMap.looking');
  const shown = placed.kind !== 'none';
  const riding = placed.kind === 'riding';
  const live = shown && pos?.kind === 'live';
  const next = riding && pos?.next_stop && pos.expected_at_next ? pos : null;

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
          {live ? <StatusBadge status="live" /> : null}
        </View>
        <Text style={styles.main}>{main}</Text>
        {shown && pos ? (
          <Text style={styles.small}>{sourceText(pos, positionAgeS(pos, now))}</Text>
        ) : null}
        <View style={styles.rows}>
          {next ? (
            <Row
              label={t('liveMap.nextStop', { stop: next.next_stop!.name })}
              right={<Text style={styles.time}>{formatTime(next.expected_at_next!)}</Text>}
            />
          ) : null}
          {riding ? null : (
            <Row
              label={t('liveMap.board', { stop: leg.from })}
              right={<TimeWithDelay time={leg.departure} />}
            />
          )}
          <Row
            label={t('liveMap.getOff', { stop: leg.to })}
            right={<TimeWithDelay time={leg.arrival} />}
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
