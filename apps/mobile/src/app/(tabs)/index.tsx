// Plan: the home screen. Tapping From or To turns the field into a text box in place, with stop
// suggestions under it. In the app, as soon as both are set the Connections screen opens (like
// SBB Mobile); going back from it returns here with an empty form. On the website the planner
// is one row in the navy band and the connections sit beside the selected journey's details.

import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { ConnectionList } from '../../components/connectionList';
import { Card, BrandHeader, Divider, Screen, SectionTitle } from '../../components/layout';
import { type PlaceFieldName, PlannerCard } from '../../components/planner';
import { usePlanForm } from '../../components/planForm';
import { DisruptionsButton } from '../../components/disruptions';
import { PlanMap } from '../../components/planMap';
import { StopSuggestions } from '../../components/stopSearch';
import { TouchTimetable } from '../../components/touch';
import { StopRow } from '../../components/stops';
import { Rich } from '../../components/Rich';
import { useIsWide, type PressState } from '../../hooks';
import { type MessageKey, useT } from '../../i18n';
import { type Place, type PlanView, placeKey, setPlanner, usePlanner } from '../../state/planner';
import { type SavedStop, useSaved } from '../../state/saved';
import { colors, radius, space, themed, type } from '../../theme';

/** The Connections screen was opened from here and is still on top (outlives a re-mount). */
let connectionsOpen = false;

export default function PlanScreen() {
  const { from, to, when, arriveBy, sort, view } = usePlanner();
  const isWide = useIsWide();
  const { t } = useT();
  const form = usePlanForm();
  const { editing, text, edit, close, choose, chooseHere, other } = form;
  const ready = !!from && !!to;

  // App: once both ends are chosen (typed, tiles, saved stops…), open the Connections screen.
  // Only while this screen is in front, so changes made on the Connections screen do not open
  // another one. Back here from it (back arrow, Android back, browser back): clear the form
  // for a new search instead of opening it again.
  useFocusEffect(
    useCallback(() => {
      if (connectionsOpen) {
        connectionsOpen = false;
        setPlanner({ from: null, to: null, when: null, arriveBy: false });
      } else if (!isWide && ready && !editing) {
        connectionsOpen = true;
        router.push('/connections');
      }
    }, [isWide, ready, editing]),
  );

  const card = { ...form.card, footer: editing && !isWide ? null : form.whenBar };

  // Touch timetable: both ends chosen on the tiles, or one end chosen and the other to type.
  const planFromTiles = (a: Place, b: Place) => setPlanner({ from: a, to: b, view: 'timetable' });
  const typeFromTiles = (field: PlaceFieldName, known: Place | null) => {
    const otherEnd = field === 'to' ? 'from' : 'to';
    setPlanner({ view: 'timetable', ...(known ? { [otherEnd]: known, [field]: null } : null) });
    edit(field);
  };
  const switchView = (v: PlanView) => {
    close();
    setPlanner({ view: v });
  };

  const header = (
    <BrandHeader
      wide
      // App: "Where to?" with the logo on the right, hidden while typing to keep the form high.
      title={isWide ? t('plan.titleWide') : editing ? undefined : t('plan.whereTo')}
      subtitle={isWide ? t('plan.modes') : undefined}
      right={
        isWide || editing ? undefined : (
          <View style={styles.headerRight}>
            <DisruptionsButton />
            <Image
              source={require('../../../assets/icon.png')}
              style={styles.logo}
              accessibilityLabel="MadridGo"
            />
          </View>
        )
      }>
      {editing && !isWide ? null : <ViewSwitch view={view} onChange={switchView} />}
      {view !== 'timetable' ? null : isWide ? (
        <View style={styles.wideForm}>
          <PlannerCard
            {...card}
            layout="row"
            dropdown={
              <StopSuggestions
                text={text}
                onPick={choose}
                onHere={chooseHere}
                exclude={other}
                dropdown
              />
            }
          />
        </View>
      ) : (
        <PlannerCard {...card} />
      )}
    </BrandHeader>
  );

  if (view === 'map') {
    return (
      <Screen fill header={header}>
        <PlanMap />
      </Screen>
    );
  }

  return (
    <Screen wide header={header}>
      {view === 'touch' ? (
        <View style={styles.touch}>
          <TouchTimetable onPlan={planFromTiles} onTypeField={typeFromTiles} />
        </View>
      ) : editing && !isWide ? (
        // App: suggestions replace the content under the header while typing.
        <StopSuggestions text={text} onPick={choose} onHere={chooseHere} exclude={other} />
      ) : ready && isWide ? (
        // Keyed so "Earlier/Later" and the selection reset when the search changes.
        <ConnectionList
          key={`${placeKey(from)}|${placeKey(to)}|${when}|${arriveBy}|${sort}`}
          from={from}
          to={to}
          when={when}
          arriveBy={arriveBy}
          sort={sort}
        />
      ) : (
        <Start />
      )}
      {form.sheets}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Timetable | Touch timetable | Map

const VIEWS: { key: PlanView; label: MessageKey }[] = [
  { key: 'timetable', label: 'plan.view.timetable' },
  { key: 'touch', label: 'plan.view.touch' },
  { key: 'map', label: 'plan.view.map' },
];

function ViewSwitch({ view, onChange }: { view: PlanView; onChange: (v: PlanView) => void }) {
  const { t } = useT();
  return (
    <View style={styles.switch} accessibilityRole="tablist">
      {VIEWS.map((v) => {
        const active = v.key === view;
        return (
          <Pressable
            key={v.key}
            onPress={() => onChange(v.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={({ pressed, hovered }: PressState) => [
              styles.switchItem,
              active && styles.switchItemActive,
              !active && (pressed || hovered) && styles.switchItemHover,
            ]}>
            <Text style={[styles.switchText, active && styles.switchTextActive]} numberOfLines={1}>
              {t(v.label)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Before a search: saved and recent stops

function Start() {
  const { from } = usePlanner();
  const saved = useSaved();
  const isWide = useIsWide();
  const { t } = useT();

  const pickInto = (s: SavedStop) => {
    if (!from) setPlanner({ from: { id: s.id, name: s.name } });
    else setPlanner({ to: { id: s.id, name: s.name } });
  };

  // Saved first, then recents, never the stop already chosen as origin.
  const quick = [
    ...saved.favorites,
    ...saved.recents.filter((r) => !saved.favorites.some((f) => f.id === r.id)),
  ].filter((s) => s.id !== from?.id);

  const picks = quick.length ? (
    <View>
      <SectionTitle>{from ? t('plan.chooseDestination') : t('plan.startFrom')}</SectionTitle>
      <Card>
        {quick.slice(0, 6).map((s, i) => (
          <View key={s.id}>
            {i > 0 ? <Divider inset={56} /> : null}
            <StopRow name={s.name} modes={s.modes} lines={s.lines} onPress={() => pickInto(s)} />
          </View>
        ))}
      </Card>
    </View>
  ) : null;

  const hint = (
    <View style={styles.hint}>
      <Text style={styles.hintTitle}>{t('plan.hintTitle')}</Text>
      <Rich
        k="plan.hintBody"
        style={styles.hintBody}
        slots={{
          live: <Text style={{ color: colors.live, fontWeight: '700' }}>{t('status.live')}</Text>,
          scheduled: <Text style={{ fontWeight: '700' }}>{t('status.scheduled')}</Text>,
          every: (
            <Text style={{ color: colors.warning, fontWeight: '700' }}>
              {t('status.everyGeneric')}
            </Text>
          ),
        }}
      />
    </View>
  );

  if (isWide) {
    return (
      <View style={styles.split}>
        <View style={styles.splitList}>{picks ?? hint}</View>
        <View style={styles.splitDetail}>{picks ? hint : null}</View>
      </View>
    );
  }
  return <>{picks ?? hint}</>;
}

const styles = themed(() =>
  StyleSheet.create({
    logo: { width: 40, height: 40, borderRadius: 10 },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
    switch: {
      flexDirection: 'row',
      backgroundColor: colors.headerDark,
      borderRadius: radius.pill,
      padding: 4,
      marginTop: space.md,
      marginBottom: space.xs,
    },
    // Sized by their labels ("Touch timetable" is the longest), sharing the rest of the row.
    switchItem: {
      flexGrow: 1,
      flexShrink: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: space.sm + 2,
      paddingHorizontal: space.md,
      borderRadius: radius.pill,
    },
    switchItemActive: { backgroundColor: colors.surface },
    switchItemHover: { backgroundColor: 'rgba(255,255,255,0.08)' },
    switchText: { ...type.smallStrong, fontSize: 15, color: colors.onBrandMuted },
    switchTextActive: { color: colors.brand, fontWeight: '700' },
    touch: { width: '100%', maxWidth: 640, alignSelf: 'center' },
    // zIndex: the suggestion dropdown must cover the time chips below the form.
    wideForm: { flexDirection: 'row', marginTop: space.lg, zIndex: 20 },
    split: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: space.sm },
    splitList: { width: 460 },
    splitDetail: { flex: 1, marginTop: space.lg },
    hint: { margin: space.lg, marginTop: space.xl, gap: space.sm },
    hintTitle: { ...type.heading, color: colors.text },
    hintBody: { ...type.body, color: colors.textMuted, lineHeight: 22 },
  }),
);
