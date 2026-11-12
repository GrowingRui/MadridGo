// The From/To form's behaviour, shared by the Plan home and the Connections screen: which field
// is being typed into, choosing a stop or "Current location", and the date/time and options
// sheets opened from the row under the fields.

import { useState } from 'react';

import { useT } from '../i18n';
import {
  DEFAULT_SORT,
  HERE_ID,
  type Place,
  setPlanner,
  swapPlaces,
  usePlanner,
} from '../state/planner';
import { type SavedStop, addRecent } from '../state/saved';
import type { Point } from '../utils/location';
import type { PlaceFieldName } from './planner';
import { OptionsSheet, TimeSheet, WhenBar } from './when';

export function usePlanForm() {
  const { from, to, when, arriveBy, sort } = usePlanner();
  const { t } = useT();
  const [sheet, setSheet] = useState<'time' | 'options' | null>(null);
  // The field being typed into, in place in the header.
  const [editing, setEditing] = useState<PlaceFieldName | null>(null);
  const [text, setText] = useState('');

  const edit = (field: PlaceFieldName) => {
    setEditing(field);
    setText('');
  };
  const close = () => {
    setEditing(null);
    setText('');
  };
  const setPlace = (place: Place) => {
    const field = editing ?? 'to';
    const otherField = field === 'from' ? 'to' : 'from';
    // "Current location" can be only one end: choosing it for this end clears the other.
    const clash = place.id === HERE_ID && (field === 'from' ? to : from)?.id === HERE_ID;
    setPlanner({ [field]: place, ...(clash ? { [otherField]: null } : null) });
    // Like a timetable app: after the origin, go straight on to the destination if it is empty.
    if (field === 'from' && (!to || clash)) edit('to');
    else close();
  };
  const choose = (s: SavedStop) => {
    addRecent(s);
    setPlace({ id: s.id, name: s.name });
  };
  const chooseHere = (p: Point) => setPlace({ id: HERE_ID, name: t('here.title'), ...p });

  const whenBar = (
    <WhenBar
      when={when}
      arriveBy={arriveBy}
      optionsActive={sort !== DEFAULT_SORT}
      onOpenTime={() => setSheet('time')}
      onNow={() => setPlanner({ when: null, arriveBy: false })}
      onOpenOptions={() => setSheet('options')}
    />
  );

  const sheets = (
    <>
      <TimeSheet
        visible={sheet === 'time'}
        when={when}
        arriveBy={arriveBy}
        onClose={() => setSheet(null)}
        onApply={(w, a) => {
          setPlanner({ when: w, arriveBy: a });
          setSheet(null);
        }}
      />
      <OptionsSheet
        visible={sheet === 'options'}
        sort={sort}
        onClose={() => setSheet(null)}
        onApply={(v) => setPlanner({ sort: v })}
      />
    </>
  );

  return {
    editing,
    text,
    setText,
    edit,
    close,
    choose,
    chooseHere,
    /** The stop at the other end, not to be suggested for the field being edited. */
    other: editing === 'from' ? to?.id : from?.id,
    /** Props for PlannerCard, except the footer. */
    card: {
      from,
      to,
      onSwap: swapPlaces,
      editing,
      text,
      onEdit: edit,
      onText: setText,
      onClose: close,
    },
    whenBar,
    sheets,
  };
}
