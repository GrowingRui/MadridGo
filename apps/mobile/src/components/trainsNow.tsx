// "Trains now" on a Cercanías station board: the trains standing at the station or heading for
// it as their next stop, from the live train positions (the same data as the Live trains map).
// Quiet when there is nothing to show or the data is unavailable.

import { StyleSheet, Text, View } from 'react-native';

import { getLiveTrains } from '../api/trains';
import { useAsync, useNow } from '../hooks';
import { useT } from '../i18n';
import { colors, space, themed, type } from '../theme';
import { trainsAtStation } from '../utils/liveTrains';
import { formatTime } from '../utils/time';
import { useEffect } from 'react';
import { Card, Divider, SectionTitle } from './layout';
import { LinePill } from './transit';

export function TrainsNow({ stopId }: { stopId: string }) {
  const { t } = useT();
  const now = useNow();
  const live = useAsync(() => getLiveTrains(), stopId);
  const { reload } = live;
  useEffect(() => {
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [reload]);

  const rows = live.data ? trainsAtStation(live.data.trains, stopId, now) : [];
  if (!rows.length) return null;
  return (
    <>
      <SectionTitle>{t('trainsNow.title')}</SectionTitle>
      <Card>
        {rows.map(({ train, state, at, estimated }, i) => {
          const mins = at ? Math.max(0, Math.floor((Date.parse(at) - now) / 60_000)) : 0;
          const text = state === 'at' ? t('trainsNow.at') : mins === 0 ? t('time.now') : `${mins}′`;
          const delay = train.delay_s ? Math.round(train.delay_s / 60) : 0;
          return (
            <View key={train.trip_id}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <View
                style={styles.row}
                accessible
                accessibilityLabel={t('trainsNow.a11y', {
                  line: train.line?.short_name ?? '',
                  headsign: train.headsign ?? '',
                  when: state === 'at' ? t('trainsNow.at') : mins === 0 ? t('time.now') : `${mins} min`,
                })}>
                <Text style={[type.timeL, styles.time, { color: estimated ? colors.text : colors.live }]}>
                  {text}
                </Text>
                {train.line ? <LinePill line={train.line} /> : null}
                <View style={{ flex: 1 }}>
                  <Text style={styles.head} numberOfLines={2}>
                    {train.headsign ?? '—'}
                  </Text>
                  <Text style={styles.sub}>
                    {[
                      state === 'arriving' && at ? t('dep.about', { time: formatTime(at) }) : null,
                      estimated ? t('trainsNow.estimated') : t('trainsNow.live'),
                      delay >= 2 ? t('trainsNow.late', { n: delay }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </Card>
    </>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
    },
    time: { minWidth: 56 },
    head: { ...type.bodyStrong, color: colors.text },
    sub: { ...type.small, color: colors.textMuted },
  }),
);
