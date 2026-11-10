// When to travel, inside the From/To card as on Swiss timetables:
//   Mon 09.11. | 21:29 Dep | ⟲                      | ⚙
// Tapping the date or time opens the time picker (departure or arrival, day, time); ⟲ goes back
// to "now"; the button on the right opens connection options (sort order).

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { type ReactNode, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { SortOption } from '../api/journeys';
import { type PressState, useIsWide, useNow } from '../hooks';
import { useT } from '../i18n';
import { colors, radius, space, themed, type } from '../theme';
import {
  dayLabel,
  formatDateShort,
  formatTime,
  fromMadrid,
  madridDayStart,
  madridParts,
} from '../utils/time';
import { Button } from './layout';

// ---------------------------------------------------------------------------
// The row inside the card

export function WhenBar({
  when,
  arriveBy,
  optionsActive,
  onOpenTime,
  onNow,
  onOpenOptions,
}: {
  when: number | null;
  arriveBy: boolean;
  optionsActive: boolean;
  onOpenTime: () => void;
  onNow: () => void;
  onOpenOptions: () => void;
}) {
  const { t } = useT();
  const now = useNow();
  const at = when ?? now;
  const isNow = when == null && !arriveBy;
  const timeLabel = `${formatTime(at)} ${arriveBy ? t('when.arr') : t('when.dep')}`;
  return (
    <View style={styles.bar}>
      <Pressable
        onPress={onOpenTime}
        accessibilityRole="button"
        accessibilityLabel={
          t(arriveBy ? 'when.a11yArr' : 'when.a11yDep', {
            date: formatDateShort(at),
            time: formatTime(at),
          }) +
          (isNow ? t('when.a11yNow') : '') +
          t('when.a11yChange')
        }
        style={({ pressed, hovered }: PressState) => [
          styles.barMain,
          (pressed || hovered) && styles.pressed,
        ]}>
        <Text style={styles.barText}>{formatDateShort(at)}</Text>
        <View style={styles.sep} />
        <Text style={styles.barText}>{timeLabel}</Text>
      </Pressable>
      <View style={styles.sep} />
      <Pressable
        onPress={onNow}
        disabled={isNow}
        accessibilityRole="button"
        accessibilityLabel={t('when.departNow')}
        accessibilityState={{ disabled: isNow }}
        hitSlop={6}
        style={({ pressed, hovered }: PressState) => [
          styles.iconBtn,
          !isNow && (pressed || hovered) && styles.pressed,
        ]}>
        <MaterialCommunityIcons
          name="history"
          size={22}
          color={isNow ? colors.textFaint : colors.brand}
        />
      </Pressable>
      <View style={{ flex: 1 }} />
      <View style={styles.sepTall} />
      <Pressable
        onPress={onOpenOptions}
        accessibilityRole="button"
        accessibilityLabel={t('when.options') + (optionsActive ? t('when.optionsChanged') : '')}
        hitSlop={6}
        style={({ pressed, hovered }: PressState) => [
          styles.iconBtn,
          styles.optionsBtn,
          (pressed || hovered) && styles.pressed,
        ]}>
        <MaterialCommunityIcons name="tune-variant" size={22} color={colors.brand} />
        {optionsActive ? <View style={styles.dot} /> : null}
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sheets (bottom sheet in the app, centred dialog on the website)

function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { t } = useT();
  const isWide = useIsWide();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, isWide ? styles.backdropWide : styles.backdropApp]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.dismiss')}
        />
        <View
          style={[styles.sheet, isWide ? styles.sheetWide : styles.sheetApp]}
          accessibilityViewIsModal>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              {title}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              hitSlop={10}>
              <MaterialCommunityIcons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          {children}
          <View style={styles.sheetFooter}>{footer}</View>
        </View>
      </View>
    </Modal>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[styles.segment, on && styles.segmentOn]}>
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Stepper({
  label,
  value,
  onMinus,
  onPlus,
}: {
  label: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
}) {
  const { t } = useT();
  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={onPlus}
        accessibilityRole="button"
        accessibilityLabel={t('when.later', { unit: label })}
        style={({ pressed, hovered }: PressState) => [
          styles.stepBtn,
          (pressed || hovered) && styles.pressed,
        ]}>
        <MaterialCommunityIcons name="chevron-up" size={28} color={colors.brand} />
      </Pressable>
      <Text style={styles.stepValue} accessibilityLabel={`${label} ${value}`}>
        {value}
      </Text>
      <Pressable
        onPress={onMinus}
        accessibilityRole="button"
        accessibilityLabel={t('when.earlier', { unit: label })}
        style={({ pressed, hovered }: PressState) => [
          styles.stepBtn,
          (pressed || hovered) && styles.pressed,
        ]}>
        <MaterialCommunityIcons name="chevron-down" size={28} color={colors.brand} />
      </Pressable>
    </View>
  );
}

const DAYS_AHEAD = 7;
const two = (n: number) => String(n).padStart(2, '0');

/** Day, time and departure/arrival. Times are Madrid time whatever the device zone. */
export function TimeSheet({
  visible,
  when,
  arriveBy,
  onClose,
  onApply,
}: {
  visible: boolean;
  when: number | null;
  arriveBy: boolean;
  onClose: () => void;
  onApply: (when: number | null, arriveBy: boolean) => void;
}) {
  return visible ? (
    <TimeSheetBody when={when} arriveBy={arriveBy} onClose={onClose} onApply={onApply} />
  ) : null;
}

function TimeSheetBody({
  when,
  arriveBy,
  onClose,
  onApply,
}: {
  when: number | null;
  arriveBy: boolean;
  onClose: () => void;
  onApply: (when: number | null, arriveBy: boolean) => void;
}) {
  const { t } = useT();
  // A fresh draft each time the sheet opens (this body is mounted only while visible).
  const [now] = useState(() => Date.now());
  const start = madridParts(when ?? now);
  const [mode, setMode] = useState<'dep' | 'arr'>(arriveBy ? 'arr' : 'dep');
  const [dayOffset, setDayOffset] = useState(() =>
    Math.min(
      DAYS_AHEAD - 1,
      Math.max(0, Math.round((madridDayStart(when ?? now) - madridDayStart(now)) / 86_400_000)),
    ),
  );
  const [hour, setHour] = useState(start.hour);
  const [minute, setMinute] = useState(start.minute);

  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => madridDayStart(now, i));
  const stepMinute = (d: 5 | -5) =>
    setMinute((m) => {
      const next = d > 0 ? Math.floor((m + 5) / 5) * 5 : Math.ceil((m - 5) / 5) * 5;
      return (next + 60) % 60;
    });

  const apply = () => {
    const day = madridParts(days[dayOffset] + 12 * 3_600_000); // noon: safe on DST days
    onApply(fromMadrid(day.year, day.month, day.day, hour, minute), mode === 'arr');
  };

  return (
    <Sheet
      visible
      title={t('when.title')}
      onClose={onClose}
      footer={
        <>
          <Button
            label={t('common.now')}
            variant="secondary"
            onPress={() => onApply(null, false)}
          />
          <View style={{ flex: 1 }} />
          <Button label={t('common.done')} onPress={apply} />
        </>
      }>
      <Segmented
        label={t('when.depOrArr')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'dep', label: t('when.departure') },
          { value: 'arr', label: t('when.arrival') },
        ]}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.days}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('when.day')}>
        {days.map((d, i) => {
          const on = i === dayOffset;
          return (
            <Pressable
              key={d}
              onPress={() => setDayOffset(i)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={[styles.day, on && styles.dayOn]}>
              <Text style={[styles.dayText, on && styles.dayTextOn]}>{dayLabel(d, now)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.time}>
        <Stepper
          label={t('when.hour')}
          value={two(hour)}
          onPlus={() => setHour((h) => (h + 1) % 24)}
          onMinus={() => setHour((h) => (h + 23) % 24)}
        />
        <Text style={styles.colon}>:</Text>
        <Stepper
          label={t('when.minutes')}
          value={two(minute)}
          onPlus={() => stepMinute(5)}
          onMinus={() => stepMinute(-5)}
        />
      </View>
      <Text style={styles.hint}>
        {mode === 'arr' ? t('when.hintArr') : t('when.hintDep')} {t('when.madridTime')}
      </Text>
    </Sheet>
  );
}

const SORTS: SortOption[] = ['earliest_arrival', 'fastest', 'fewest_transfers', 'least_walking'];

export function OptionsSheet({
  visible,
  sort,
  onClose,
  onApply,
}: {
  visible: boolean;
  sort: SortOption;
  onClose: () => void;
  onApply: (sort: SortOption) => void;
}) {
  const { t } = useT();
  return (
    <Sheet
      visible={visible}
      title={t('when.options')}
      onClose={onClose}
      footer={
        <>
          <View style={{ flex: 1 }} />
          <Button label={t('common.done')} onPress={onClose} />
        </>
      }>
      <Text style={styles.groupLabel}>{t('sort.title')}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t('sort.title')}>
        {SORTS.map((value) => {
          const on = value === sort;
          return (
            <Pressable
              key={value}
              onPress={() => onApply(value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={({ pressed, hovered }: PressState) => [
                styles.option,
                (pressed || hovered) && styles.pressed,
              ]}>
              <MaterialCommunityIcons
                name={on ? 'radiobox-marked' : 'radiobox-blank'}
                size={22}
                color={on ? colors.brand : colors.textFaint}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.optionLabel}>{t(`sort.${value}`)}</Text>
                <Text style={styles.optionHint}>{t(`sort.${value}.hint`)}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

const styles = themed(() => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingLeft: space.sm,
  },
  barMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
  },
  barText: { ...type.body, color: colors.text, fontVariant: ['tabular-nums'] },
  sep: { width: StyleSheet.hairlineWidth, height: 20, backgroundColor: colors.border },
  sepTall: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: colors.border,
  },
  iconBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  optionsBtn: { minWidth: 56 },
  dot: {
    position: 'absolute',
    top: 10,
    right: 14,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  pressed: { backgroundColor: colors.brandTint },

  backdrop: { flex: 1, backgroundColor: colors.backdrop },
  backdropApp: { justifyContent: 'flex-end' },
  backdropWide: { justifyContent: 'center', alignItems: 'center' },
  sheet: { backgroundColor: colors.surface, padding: space.lg, gap: space.lg },
  sheetApp: { borderTopLeftRadius: radius.md * 2, borderTopRightRadius: radius.md * 2 },
  sheetWide: { width: 440, borderRadius: radius.md * 2 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { ...type.heading, color: colors.text },
  sheetFooter: { flexDirection: 'row', alignItems: 'center', gap: space.sm },

  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.scheduledBg,
    borderRadius: radius.md,
    padding: 3,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.sm },
  segmentOn: { backgroundColor: colors.surface, boxShadow: '0 1px 3px rgba(11, 58, 130, 0.2)' },
  segmentText: { ...type.bodyStrong, color: colors.textMuted },
  segmentTextOn: { color: colors.brand },

  days: { gap: space.sm },
  day: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dayOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayText: { ...type.smallStrong, color: colors.text },
  dayTextOn: { color: colors.onPrimary },

  time: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.md },
  stepper: { alignItems: 'center' },
  stepBtn: {
    width: 64,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  stepValue: { ...type.timeXL, fontSize: 40, lineHeight: 48, color: colors.text },
  colon: { ...type.timeXL, fontSize: 40, lineHeight: 48, color: colors.text },
  hint: { ...type.small, color: colors.textMuted, textAlign: 'center' },

  groupLabel: { ...type.smallStrong, color: colors.textMuted },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  optionLabel: { ...type.bodyStrong, color: colors.text },
  optionHint: { ...type.small, color: colors.textMuted },
}));
