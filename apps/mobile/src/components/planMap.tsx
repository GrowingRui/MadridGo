// Plan > Map: a map of Madrid with the stops around where you look (from zoom 14), a search box
// for stops and a button to show your position. Tapping a stop opens its departures.
// "Live trains" (Phase 6) adds every Cercanías train moving on its line, like a Flightradar for
// Madrid's suburban trains; tapping one opens its card, and from there all its stops.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router, useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { type Line, type StopSummary, nearbyStops, searchStops } from '../api/stops';
import { getTrainLines } from '../api/trains';
import { useAsync, useDebounced, useLiveTrains, useNow, useReduceMotion } from '../hooks';
import { useT } from '../i18n';
import { trainCache } from '../state/journeys';
import { setPlanner, usePlanner } from '../state/planner';
import { colors, currentScheme, radius, space, themed, type } from '../theme';
import { linesRunning, trainDots } from '../utils/liveTrains';
import { LocationError, getCurrentPoint } from '../utils/location';
import { decodePolyline } from '../utils/polyline';
import { Divider } from './layout';
import { LineFilter, LiveTrainsSwitch, TrainCard, TrainsStatus } from './liveTrains';
import { MapFrame, type MapHandle } from './mapFrame';
import { MADRID, STOPS_MIN_ZOOM, mapHtml } from './mapHtml';
import { stopDetail } from './stopSearch';
import { StopRow } from './stops';

/** Live trains switched on: zoomed out to see the Cercanías network. */
const TRAINS_ZOOM = 9.6;

export function PlanMap() {
  const { t, tn, lang } = useT();
  const map = useRef<MapHandle>(null);
  const ready = useRef(false);
  const queue = useRef<object[]>([]);
  const lastLoad = useRef(0);
  const [text, setText] = useState('');
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Live trains: polled only while switched on and this screen is in front.
  const { liveTrains: trainsOn, trainLine } = usePlanner();
  const focused = useIsFocused();
  const reduceMotion = useReduceMotion();
  const trains = useLiveTrains(trainsOn && focused);
  const lines = useAsync(trainsOn ? getTrainLines : null, trainsOn ? 'lines' : '');
  const now = useNow(trainsOn ? 1000 : 60_000);
  const [selected, setSelected] = useState<string | null>(null);
  const all = trains.data?.trains ?? [];
  const dots = trainsOn ? trainDots(all, now, trainLine) : [];
  const picked = selected ? all.find((x) => x.trip_id === selected) : undefined;
  const pickedShown = picked && dots.some((d) => d.id === picked.trip_id) ? picked : undefined;

  // Rebuilt only when the language changes (it reloads the map). A new scheme re-mounts the
  // screen (app/_layout.tsx), so the map style follows it.
  const html = useMemo(
    () => mapHtml({ departures: t('map.departures'), zoomIn: t('map.zoomIn') }, currentScheme()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang],
  );

  const post = (msg: object) => {
    if (ready.current) map.current?.post(msg);
    else queue.current.push(msg);
  };

  const loadStops = async (lat: number, lon: number) => {
    const call = ++lastLoad.current;
    try {
      const stops = await nearbyStops(lat, lon, 1200, 50);
      if (call !== lastLoad.current) return; // the map moved again meanwhile
      post({
        type: 'stops',
        stops: stops
          .filter((s) => s.lat != null && s.lon != null)
          .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, mode: s.modes[0] ?? 'bus' })),
      });
    } catch {
      // Keep the stops already drawn; the next move tries again.
    }
  };

  const onMessage = (msg: { type: string; [k: string]: unknown }) => {
    if (msg.type === 'ready') {
      ready.current = true;
      setMapReady(true);
      queue.current.splice(0).forEach((m) => map.current?.post(m));
    } else if (msg.type === 'moved') {
      if ((msg.zoom as number) >= STOPS_MIN_ZOOM) void loadStops(msg.lat as number, msg.lon as number);
      else post({ type: 'stops', stops: [] });
    } else if (msg.type === 'stop') {
      router.push({ pathname: '/stop/[id]', params: { id: String(msg.id) } });
    } else if (msg.type === 'trainTap') {
      setSelected(String(msg.id));
    }
  };

  // The lines' tracks under the trains; the other lines faded while one is picked.
  useEffect(() => {
    if (!mapReady) return;
    const data = trainsOn ? (lines.data?.lines ?? []) : [];
    map.current?.post({
      type: 'tracks',
      lines: data
        .filter((l) => l.paths.length)
        .map((l) => ({
          color: l.line.color ? `#${l.line.color}` : colors.brand,
          dim: trainLine != null && l.line.short_name !== trainLine,
          coords: l.paths.map(decodePolyline),
        })),
    });
  }, [mapReady, trainsOn, lines.data, trainLine]);

  // The trains, every second: each glides from where it is drawn to where it is now.
  const dotsKey = JSON.stringify(dots);
  const pickedId = pickedShown?.trip_id ?? null;
  useEffect(() => {
    if (!mapReady) return;
    map.current?.post({
      type: 'trains',
      trains: JSON.parse(dotsKey),
      selected: pickedId,
      glide: !reduceMotion,
    });
  }, [mapReady, dotsKey, pickedId, reduceMotion]);

  const toggleTrains = () => {
    setSelected(null);
    // Switched on: the whole network in view, from Guadalajara to Aranjuez and El Escorial.
    if (!trainsOn) post({ type: 'center', lat: MADRID.lat, lon: MADRID.lon, zoom: TRAINS_ZOOM });
    setPlanner({ liveTrains: !trainsOn });
  };

  const showStops = () => {
    if (!pickedShown) return;
    trainCache.set(pickedShown.trip_id, pickedShown);
    router.push({ pathname: '/trip', params: { trip: pickedShown.trip_id } });
  };

  // The line filter: lines with trains on the map now, in the network's order.
  const lineInfo = new Map<string, Line>();
  for (const l of lines.data?.lines ?? []) lineInfo.set(l.line.short_name, l.line);
  for (const x of all) {
    if (x.line && !lineInfo.has(x.line.short_name)) lineInfo.set(x.line.short_name, x.line);
  }
  const running = trainsOn ? linesRunning(all, now, [...lineInfo.keys()]) : [];
  if (trainLine && !running.includes(trainLine)) running.push(trainLine);
  const filterLines = running.map((n) => lineInfo.get(n)).filter((l): l is Line => !!l);

  let status: { text: string; tone: 'info' | 'problem' } | null = null;
  if (trainsOn) {
    if (!trains.data) {
      status = trains.failed
        ? { text: t('trains.failed'), tone: 'problem' }
        : { text: t('trains.loading'), tone: 'info' };
    } else if (trains.data.message) {
      status = { text: trains.data.message, tone: 'problem' };
    } else if (trains.failed && !dots.length) {
      status = { text: t('trains.failed'), tone: 'problem' };
    } else if (!dots.length) {
      status = {
        text: trainLine ? t('trains.noneLine', { line: trainLine }) : t('trains.none'),
        tone: 'info',
      };
    } else {
      status = { text: tn('trains.count', dots.length), tone: 'info' };
    }
  }

  const locate = async () => {
    setProblem(null);
    setLocating(true);
    try {
      const p = await getCurrentPoint();
      post({ type: 'me', ...p });
      post({ type: 'center', ...p, zoom: 16 });
    } catch (err) {
      const kind = err instanceof LocationError ? err.problem : 'failed';
      setProblem(t(kind === 'denied' ? 'here.denied' : kind === 'outside' ? 'here.outside' : 'here.failed'));
    } finally {
      setLocating(false);
    }
  };

  const show = (s: StopSummary) => {
    setText('');
    if (s.lat != null && s.lon != null) post({ type: 'center', lat: s.lat, lon: s.lon, zoom: 17 });
  };

  return (
    <View style={styles.outer}>
      <View style={styles.wrap}>
        <MapFrame ref={map} html={html} onMessage={onMessage} />
        {/* Before the search box, so its results cover these. */}
        <Pressable
          onPress={locate}
          disabled={locating}
          accessibilityRole="button"
          accessibilityLabel={t('map.locate')}
          style={({ pressed }) => [styles.locate, pressed && { backgroundColor: colors.brandTint }]}>
          {locating ? (
            <ActivityIndicator color={colors.brand} />
          ) : (
            <MaterialCommunityIcons name="crosshairs-gps" size={24} color={colors.brand} />
          )}
        </Pressable>
        {problem ? (
          <Pressable style={styles.problem} onPress={() => setProblem(null)} accessibilityRole="alert">
            <Text style={styles.problemText}>{problem}</Text>
          </Pressable>
        ) : null}

        <View style={styles.searchArea} pointerEvents="box-none">
          <View style={styles.search}>
            <MaterialCommunityIcons name="magnify" size={22} color={colors.textMuted} />
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={t('map.search')}
              placeholderTextColor={colors.textFaint}
              style={[styles.input, Platform.OS === 'web' && ({ outlineStyle: 'none' } as object)]}
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel={t('map.search')}
            />
            {text ? (
              <Pressable onPress={() => setText('')} accessibilityRole="button" accessibilityLabel={t('common.clear')} hitSlop={10}>
                <MaterialCommunityIcons name="close-circle" size={20} color={colors.textFaint} />
              </Pressable>
            ) : null}
          </View>
          <SearchResults text={text} onPick={show} />
          {text ? null : (
            <View style={styles.trainControls} pointerEvents="box-none">
              <LiveTrainsSwitch on={trainsOn} onToggle={toggleTrains} />
              {trainsOn && filterLines.length ? (
                <LineFilter
                  lines={filterLines}
                  selected={trainLine}
                  onSelect={(line) => setPlanner({ trainLine: line })}
                />
              ) : null}
            </View>
          )}
        </View>
      </View>
      {pickedShown ? (
        <TrainCard
          train={pickedShown}
          now={now}
          onClose={() => setSelected(null)}
          onShowStops={showStops}
        />
      ) : status ? (
        <TrainsStatus text={status.text} tone={status.tone} />
      ) : null}
    </View>
  );
}

function SearchResults({ text, onPick }: { text: string; onPick: (s: StopSummary) => void }) {
  const { t } = useT();
  const q = useDebounced(text.trim(), 250);
  const results = useAsync(q.length >= 2 ? () => searchStops(q, 8) : null, q);
  if (q.length < 2 || !text.trim()) return null;
  return (
    <View style={styles.results}>
      {results.loading && !results.data ? (
        <Text style={styles.resultsNote}>{t('search.searching')}</Text>
      ) : !results.data?.length ? (
        <Text style={styles.resultsNote}>{t('search.noMatch', { q })}</Text>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 320 }}>
          {results.data.map((s, i) => (
            <View key={s.id}>
              {i > 0 ? <Divider inset={56} /> : null}
              <StopRow
                name={s.name}
                modes={s.modes}
                lines={s.lines}
                detail={stopDetail(s)}
                icon="map-marker-outline"
                onPress={() => onPick(s)}
              />
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const shadow = Platform.select({
  web: { boxShadow: '0 2px 10px rgba(0,0,0,0.18)' } as object,
  default: { elevation: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
});

const styles = themed(() => StyleSheet.create({
  outer: { flex: 1 },
  wrap: { flex: 1, minHeight: 420, overflow: 'hidden' },
  // Below the search box; stops short of the locate button on the right.
  trainControls: { marginTop: space.sm, marginRight: 56, gap: space.xs },
  searchArea: {
    position: 'absolute',
    top: space.md,
    left: space.lg,
    right: space.lg,
    maxWidth: 480, // website: a search box, not a full-width bar
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    ...shadow,
  },
  input: { flex: 1, ...type.body, color: colors.text, paddingVertical: 12 },
  results: {
    marginTop: space.xs,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    overflow: 'hidden',
    ...shadow,
  },
  resultsNote: { ...type.small, color: colors.textMuted, padding: space.lg },
  locate: {
    position: 'absolute',
    top: 76,
    right: space.lg,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  problem: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.xl,
    backgroundColor: colors.toast,
    borderRadius: radius.md,
    padding: space.md,
  },
  problemText: { ...type.small, color: colors.onBrand },
}));
