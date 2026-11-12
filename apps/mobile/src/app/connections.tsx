// Connections (app), like SBB Mobile's: opened from the Plan home once From and To are both set.
// A "Connections" bar with a back arrow, the From/To card with swap and the date/time row, then
// the list. A field can still be changed here; back on the Plan home the form is empty again
// for a new search.

import { router } from 'expo-router';

import { ConnectionList } from '../components/connectionList';
import { BrandHeader, EmptyState, Screen } from '../components/layout';
import { PlannerCard } from '../components/planner';
import { usePlanForm } from '../components/planForm';
import { StopSuggestions } from '../components/stopSearch';
import { useT } from '../i18n';
import { placeKey, usePlanner } from '../state/planner';

export default function ConnectionsScreen() {
  const { from, to, when, arriveBy, sort } = usePlanner();
  const { t } = useT();
  const form = usePlanForm();
  const { editing, text, close, choose, chooseHere, other } = form;

  // While typing, the back arrow leaves the search box first.
  const back = () => {
    if (editing) close();
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const header = (
    <BrandHeader title={editing ? undefined : t('conns.title')} onBack={back}>
      <PlannerCard {...form.card} footer={editing ? null : form.whenBar} />
    </BrandHeader>
  );

  return (
    <Screen header={header}>
      {editing ? (
        <StopSuggestions text={text} onPick={choose} onHere={chooseHere} exclude={other} />
      ) : from && to ? (
        // Keyed so "Earlier/Later" reset when the search changes.
        <ConnectionList
          key={`${placeKey(from)}|${placeKey(to)}|${when}|${arriveBy}|${sort}`}
          from={from}
          to={to}
          when={when}
          arriveBy={arriveBy}
          sort={sort}
        />
      ) : (
        <EmptyState icon="map-marker-path" title={t('conns.choose')} />
      )}
      {form.sheets}
    </Screen>
  );
}
