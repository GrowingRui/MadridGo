// "Find alternatives from …" (R12, SBB's alternative connections): on a connection with a
// cancelled train, a change that no longer works or one at risk, a button that searches again
// from where the traveller will be next (utils/replan.ts), leaving the cancelled train out.
// A cancelled train or impossible change is already explained by JourneyNotices above; a
// change at risk gets its own line here.

import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import type { Journey } from '../api/journeys';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { type Place, startSearch } from '../state/planner';
import { space, themed } from '../theme';
import { replanFrom, replanReason } from '../utils/replan';
import { Button, Notice } from './layout';

export function ReplanButton({
  journey,
  from,
  to,
}: {
  journey: Journey;
  /** What was planned; without it there is nothing to search again for. */
  from: Place | null;
  to: Place | null;
}) {
  const { t } = useT();
  const now = useNow(30_000);
  if (!from || !to) return null;
  const reason = replanReason(journey, now);
  const replan = reason ? replanFrom(journey, from, to, now) : null;
  if (!reason || !replan) return null;
  const fromStart = replan.from.id === from.id;
  const search = () => {
    startSearch({ from: replan.from, to, when: replan.at, avoid: replan.avoid });
    // The Plan screen opens the connections for it (app) or lists them (website).
    router.dismissTo('/');
  };
  return (
    <View style={styles.box}>
      {reason === 'atRisk' ? (
        <Notice tone="warning" icon="clock-alert-outline">
          {t('replan.atRisk')}
        </Notice>
      ) : null}
      {/* Notice brings its own side margin; the button gets the same. */}
      <View style={styles.button}>
        <Button
          label={
            fromStart ? t('replan.button') : t('replan.buttonFrom', { stop: replan.from.name })
          }
          icon="swap-horizontal"
          variant="secondary"
          onPress={search}
        />
      </View>
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    box: { marginTop: space.md },
    button: { marginHorizontal: space.lg, marginTop: space.md },
  }),
);
