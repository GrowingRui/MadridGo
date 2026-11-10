// Touch timetable: the traveller's stops as big tiles. Tap a start tile, then a destination
// tile (or drag from one to the other) and the connections appear, with no typing. Under the
// tiles: "Current location", and "from" / "to" to type the other end. Tiles are the starred
// stops first, then recent ones; "Edit" removes tiles.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useT } from '../i18n';
import { HERE_ID, type Place } from '../state/planner';
import {
  type SavedStop,
  isFavorite,
  removeRecent,
  toggleFavorite,
  useSaved,
} from '../state/saved';
import { colors, radius, space, themed, type } from '../theme';
import { LocationError, getCurrentPoint } from '../utils/location';
import { EmptyState } from './layout';
import { ModeIcon } from './transit';

const MAX_TILES = 10;
const place = (s: SavedStop): Place => ({ id: s.id, name: s.name });
const TILE_HEIGHT = 104;
const GAP = 4;

type Rect = { x: number; y: number; w: number; h: number };

export function TouchTimetable({
  onPlan,
  onTypeField,
}: {
  /** Both ends chosen: show the connections. */
  onPlan: (from: Place, to: Place) => void;
  /** Open the timetable form with this field ready to type; `known` fills the other end. */
  onTypeField: (field: 'from' | 'to', known: Place | null) => void;
}) {
  const { t } = useT();
  const saved = useSaved();
  const [origin, setOrigin] = useState<Place | null>(null);
  const [editing, setEditing] = useState(false);
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const tiles = useMemo(() => {
    const favs = saved.favorites;
    const recents = saved.recents.filter((r) => !favs.some((f) => f.id === r.id));
    return [...favs, ...recents].slice(0, MAX_TILES);
  }, [saved]);

  const finish = (from: Place, to: Place) => {
    setOrigin(null);
    setProblem(null);
    onPlan(from, to);
  };

  // Dragging from one tile to another (created once; see TileDrag below).
  const [drag, setDrag] = useState<DragState>(null);
  const [dragger] = useState(() => new TileDrag(setDrag));
  useEffect(() => {
    dragger.update(tiles, editing, (a, b) => finish(place(a), place(b)));
  });

  const tapTile = (s: SavedStop) => {
    if (dragger.justDragged) return; // the end of a drag, not a tap
    if (editing) {
      if (isFavorite(s.id, saved)) toggleFavorite(s);
      else removeRecent(s.id);
      return;
    }
    if (!origin) setOrigin(place(s));
    else if (origin.id === s.id) setOrigin(null);
    else finish(origin, place(s));
  };

  const tapHere = async () => {
    setProblem(null);
    setLocating(true);
    try {
      const p = await getCurrentPoint();
      const here: Place = { id: HERE_ID, name: t('here.title'), ...p };
      if (!origin) setOrigin(here);
      else if (origin.id === HERE_ID) setOrigin(null);
      else finish(origin, here);
    } catch (err) {
      const kind = err instanceof LocationError ? err.problem : 'failed';
      setProblem(t(kind === 'denied' ? 'here.denied' : kind === 'outside' ? 'here.outside' : 'here.failed'));
    } finally {
      setLocating(false);
    }
  };

  const hint = editing
    ? t('touch.editHint')
    : origin
      ? t('touch.pickedHint', { name: origin.id === HERE_ID ? t('here.title') : origin.name })
      : t('touch.hint');

  return (
    <View style={styles.wrap}>
      <Text style={[styles.hint, origin && styles.hintActive]} accessibilityLiveRegion="polite">
        {hint}
      </Text>
      {tiles.length ? (
        <View
          ref={(node) => dragger.setGrid(node)}
          style={styles.grid}
          onLayout={dragger.measureGrid}
          onTouchStart={Platform.OS === 'web' ? undefined : dragger.measureGrid}
          {...(Platform.OS === 'web' ? null : dragger.handlers)}>
          {tiles.map((s, i) => (
            <Tile
              key={s.id}
              index={i}
              stop={s}
              starred={isFavorite(s.id, saved)}
              chosen={origin?.id === s.id || drag?.from === i}
              target={drag?.over === i && drag.from !== i}
              editing={editing}
              onPress={() => tapTile(s)}
              onLayout={(r) => dragger.setRect(i, r)}
            />
          ))}
        </View>
      ) : (
        <EmptyState icon="gesture-tap" title={t('touch.emptyTitle')} body={t('touch.emptyBody')} />
      )}

      <View style={styles.actions}>
        <ActionTile
          wide
          icon="crosshairs-gps"
          label={t('here.title')}
          chosen={origin?.id === HERE_ID}
          busy={locating}
          onPress={tapHere}
        />
        <ActionTile
          icon="ray-start"
          label={t('touch.from')}
          a11y={t('touch.fromA11y')}
          onPress={() => {
            // A chosen tile becomes the start; type the destination.
            const known = origin;
            setOrigin(null);
            onTypeField('to', known);
          }}
        />
        <ActionTile
          icon="ray-end"
          label={t('touch.to')}
          a11y={t('touch.toA11y')}
          onPress={() => {
            // A chosen tile becomes the destination; type the start.
            const known = origin;
            setOrigin(null);
            onTypeField('from', known);
          }}
        />
      </View>
      {problem ? <Text style={styles.problem}>{problem}</Text> : null}

      {tiles.length ? (
        <View style={styles.footer}>
          <Pressable
            onPress={() => {
              setEditing((e) => !e);
              setOrigin(null);
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.editButton, pressed && { opacity: 0.7 }]}>
            <Text style={styles.editText}>{editing ? t('touch.done') : t('touch.edit')}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

type DragState = { from: number; over: number | null } | null;
type GridNode = {
  measure?: (cb: (x: number, y: number, w: number, h: number, px: number, py: number) => void) => void;
  getBoundingClientRect?: () => DOMRect;
};

/**
 * Finds the tile under the finger while dragging across the grid. Tile rectangles come from
 * onLayout (relative to the grid); the grid's own screen position is measured when a touch
 * starts. A drag starts only after 10 px, so plain taps stay with the tiles' buttons.
 */
class TileDrag {
  private tiles: SavedStop[] = [];
  private editing = false;
  private onDrop: (from: SavedStop, to: SavedStop) => void = () => {};
  justDragged = false;
  private grid: GridNode | null = null;
  private rects: Rect[] = [];
  private pos = { x: 0, y: 0 };
  protected from: number | null = null;
  readonly handlers;

  constructor(private readonly show: (d: DragState) => void) {
    this.handlers = PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        if (this.editing || Math.hypot(g.dx, g.dy) < 10) return false;
        if (Platform.OS === 'web') this.measureGrid();
        return this.tileAt(g.x0, g.y0) != null;
      },
      onPanResponderGrant: (_e, g) => {
        this.from = this.tileAt(g.x0, g.y0);
        this.show(this.from == null ? null : { from: this.from, over: null });
      },
      onPanResponderMove: (_e, g) => {
        if (this.from != null) this.show({ from: this.from, over: this.tileAt(g.moveX, g.moveY) });
      },
      onPanResponderRelease: (_e, g) => {
        const from = this.from;
        const to = this.tileAt(g.moveX, g.moveY);
        this.reset();
        // On the website a click can follow the mouse release: don't count it as a tap.
        this.justDragged = true;
        setTimeout(() => (this.justDragged = false), 400);
        if (from != null && to != null && from !== to) this.onDrop(this.tiles[from], this.tiles[to]);
      },
      onPanResponderTerminate: () => this.reset(),
    }).panHandlers;
  }

  update(tiles: SavedStop[], editing: boolean, onDrop: (from: SavedStop, to: SavedStop) => void) {
    this.tiles = tiles;
    this.editing = editing;
    this.onDrop = onDrop;
  }

  setGrid = (node: unknown) => {
    if (node === this.grid) return;
    this.detachWeb?.();
    this.detachWeb = undefined;
    this.grid = node as GridNode | null;
    if (Platform.OS === 'web' && node) this.detachWeb = this.attachWeb(node as HTMLElement);
  };

  private detachWeb?: () => void;

  /**
   * Website: React Native Web leaves a mouse drag with the tile's button, so follow the
   * browser's pointer events instead and find the tile under the pointer from the page.
   */
  private attachWeb(el: HTMLElement) {
    const tileUnder = (e: PointerEvent): number | null => {
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-tile]');
      const i = hit ? Number(hit.getAttribute('data-tile')) : NaN;
      return Number.isInteger(i) && i < this.tiles.length ? i : null;
    };
    let start: { i: number; x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      const i = this.editing ? null : tileUnder(e);
      start = i == null ? null : { i, x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      if (this.from == null) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) return;
        this.from = start.i;
      }
      this.show({ from: this.from, over: tileUnder(e) });
    };
    const up = (e: PointerEvent) => {
      const from = this.from;
      start = null;
      if (from == null) return; // a plain click: the tile's button handles it
      const to = tileUnder(e);
      this.reset();
      this.justDragged = true;
      setTimeout(() => (this.justDragged = false), 400);
      if (to != null && from !== to) this.onDrop(this.tiles[from], this.tiles[to]);
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }

  setRect = (i: number, r: Rect) => {
    this.rects[i] = r;
  };

  measureGrid = () => {
    const g = this.grid;
    if (Platform.OS === 'web' && g?.getBoundingClientRect) {
      const r = g.getBoundingClientRect();
      this.pos = { x: r.left + window.scrollX, y: r.top + window.scrollY };
    } else {
      g?.measure?.((_x, _y, _w, _h, px, py) => {
        this.pos = { x: px, y: py };
      });
    }
  };

  private tileAt(pageX: number, pageY: number): number | null {
    const x = pageX - this.pos.x;
    const y = pageY - this.pos.y;
    const i = this.rects.findIndex((r) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    return i >= 0 && i < this.tiles.length ? i : null;
  }

  private reset() {
    this.from = null;
    this.show(null);
  }
}

/** A stop tile: navy with faint "street" lines (different per stop), mode and name. */
function Tile({
  index,
  stop,
  starred,
  chosen,
  target,
  editing,
  onPress,
  onLayout,
}: {
  index: number;
  stop: SavedStop;
  starred: boolean;
  chosen: boolean;
  target: boolean;
  editing: boolean;
  onPress: () => void;
  onLayout: (r: Rect) => void;
}) {
  const { t } = useT();
  const pattern = useMemo(() => streetPattern(stop.id), [stop.id]);
  return (
    <View
      style={styles.tileCell}
      // Website: lets the drag code find the tile under the pointer (data-tile).
      {...({ dataSet: { tile: String(index) } } as object)}
      onLayout={(e) => {
        const { x, y, width, height } = e.nativeEvent.layout;
        onLayout({ x, y, w: width, h: height });
      }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ selected: chosen }}
        accessibilityLabel={editing ? t('touch.remove', { name: stop.name }) : stop.name}
        style={({ pressed }) => [
          styles.tile,
          (pressed || target) && styles.tileTarget,
          chosen && styles.tileChosen,
        ]}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {pattern.map((p, k) => (
            <View key={k} style={[styles.street, p]} />
          ))}
        </View>
        <View style={styles.tileTop}>
          <ModeIcon mode={stop.modes[0] ?? 'bus'} size={16} color={colors.onBrandMuted} />
          {starred ? (
            <MaterialCommunityIcons name="star" size={14} color={colors.accent} />
          ) : null}
        </View>
        <Text style={styles.tileName} numberOfLines={2}>
          {stop.name}
        </Text>
        {editing ? (
          <View style={styles.removeBadge}>
            <MaterialCommunityIcons name="close" size={16} color={colors.brand} />
          </View>
        ) : null}
        {chosen ? (
          <View style={styles.fromBadge}>
            <Text style={styles.fromBadgeText}>{t('touch.from')}</Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

function ActionTile({
  icon,
  label,
  a11y,
  wide,
  chosen,
  busy,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  a11y?: string;
  wide?: boolean;
  chosen?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ busy, selected: chosen }}
      style={({ pressed }) => [
        styles.action,
        wide && { flex: 2 },
        pressed && styles.tileTarget,
        chosen && styles.tileChosen,
      ]}>
      {busy ? (
        <ActivityIndicator color={colors.onBrand} />
      ) : (
        <MaterialCommunityIcons name={icon} size={26} color={colors.onBrand} />
      )}
      <Text style={[styles.actionLabel, !wide && { textAlign: 'center' }]}>{label}</Text>
    </Pressable>
  );
}

/** A few thin lines and one curve, placed from the stop id so each tile looks different. */
function streetPattern(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const rnd = () => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h >>> 0) % 1000) / 1000;
  };
  const lines = Array.from({ length: 5 }, () => ({
    left: `${Math.round(rnd() * 100) - 20}%` as const,
    top: `${Math.round(rnd() * 100)}%` as const,
    width: '90%' as const,
    height: 1,
    transform: [{ rotate: `${Math.round(rnd() * 180)}deg` }],
  }));
  const r = 120 + Math.round(rnd() * 120);
  const curve = {
    left: `${Math.round(rnd() * 60)}%` as const,
    top: -r / 2 + Math.round(rnd() * 60),
    width: r,
    height: r,
    borderRadius: r / 2,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'transparent',
  };
  return [...lines, curve];
}

const styles = themed(() => StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.lg },
  hint: { ...type.small, color: colors.textMuted, marginBottom: space.sm, minHeight: 20 },
  hintActive: { ...type.smallStrong, color: colors.brand },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -GAP / 2,
  },
  tileCell: { width: '50%', padding: GAP / 2 },
  tile: {
    height: TILE_HEIGHT,
    backgroundColor: colors.header,
    borderRadius: radius.md,
    padding: space.md,
    justifyContent: 'space-between',
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: 'transparent',
    // Text selection while dragging on the website looks broken.
    ...(Platform.OS === 'web' ? ({ userSelect: 'none', cursor: 'pointer' } as object) : null),
  },
  tileTarget: { backgroundColor: colors.headerDark, borderColor: colors.onBrand },
  tileChosen: { borderColor: colors.accent },
  street: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.16)' },
  tileTop: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  tileName: { ...type.bodyStrong, fontSize: 17, color: colors.onBrand },
  removeBadge: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.onBrand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fromBadge: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  fromBadgeText: { ...type.smallStrong, fontSize: 12, color: colors.brandDark },
  actions: { flexDirection: 'row', gap: GAP, marginTop: GAP },
  action: {
    flex: 1,
    height: TILE_HEIGHT,
    backgroundColor: colors.headerDark,
    borderRadius: radius.md,
    padding: space.md,
    justifyContent: 'space-between',
    borderWidth: 3,
    borderColor: 'transparent',
    ...(Platform.OS === 'web' ? ({ userSelect: 'none' } as object) : null),
  },
  actionLabel: { ...type.bodyStrong, color: colors.onBrand },
  problem: { ...type.small, color: colors.textMuted, marginTop: space.sm },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: space.md },
  editButton: {
    borderWidth: 1.5,
    borderColor: colors.brand,
    borderRadius: 999,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs + 2,
  },
  editText: { ...type.smallStrong, color: colors.brand },
}));
