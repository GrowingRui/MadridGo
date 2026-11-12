// Step-by-step trip guide on a trip card (SBB's journey steps): swipe through the steps of the
// trip (done, now, next), e.g. "Now · C-4 to Atocha · Get off at Atocha in 3 stops (17:22)",
// then "Change at Atocha · 6 min to change · walk 3 min to Bus 27". Opens at the step under
// way and moves on by itself as the trip goes on. Arrows under the steps for the website and
// for screen readers.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useEffect, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { Journey } from '../api/journeys';
import { type PressState, useReduceMotion } from '../hooks';
import { useT } from '../i18n';
import { colors, radius, space, themed, type } from '../theme';
import { type StepState, type TripStep, focusIndex, stepText, tripSteps } from '../utils/tripSteps';
import { LinePill, ModeIcon } from './transit';

export function TripGuide({ journey, now }: { journey: Journey; now: number }) {
  const { t } = useT();
  const reduceMotion = useReduceMotion();
  const steps = tripSteps(journey, now);
  const focus = focusIndex(steps);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(focus);
  const scroller = useRef<ScrollViewInstance>(null);
  const shownFocus = useRef<number | null>(null);

  const goTo = (i: number, animated = !reduceMotion) => {
    const k = Math.max(0, Math.min(steps.length - 1, i));
    setVisible(k);
    if (width) scroller.current?.scrollTo({ x: k * width, animated });
  };

  // Opens at the step under way; when the trip moves on to the next step, follows it.
  useEffect(() => {
    if (!width || shownFocus.current === focus) return;
    const first = shownFocus.current == null;
    shownFocus.current = focus;
    goTo(focus, !first && !reduceMotion);
    // goTo changes identity every render; focus and width are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, width]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) {
      setWidth(w);
      shownFocus.current = null; // place it again at the new width
    }
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!width) return;
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== visible && i >= 0 && i < steps.length) setVisible(i);
  };

  const current = Math.min(visible, steps.length - 1);
  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <Text style={styles.heading}>{t('steps.title')}</Text>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={100}>
        {steps.map((s, i) => (
          <StepPage key={i} journey={journey} step={s} now={now} width={width} />
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Arrow
          icon="chevron-left"
          label={t('steps.prev')}
          disabled={current === 0}
          onPress={() => goTo(current - 1)}
        />
        <View
          style={styles.dots}
          accessible
          accessibilityLabel={t('steps.position', { n: current + 1, total: steps.length })}>
          {steps.map((s, i) => (
            <View key={i} style={[styles.dot, dotStyle(s.state), i === current && styles.dotOn]} />
          ))}
        </View>
        <Arrow
          icon="chevron-right"
          label={t('steps.nextStep')}
          disabled={current === steps.length - 1}
          onPress={() => goTo(current + 1)}
        />
      </View>
    </View>
  );
}

function dotStyle(state: StepState) {
  return state === 'done' ? styles.dotDone : state === 'now' ? styles.dotNow : null;
}

function Arrow({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: 'chevron-left' | 'chevron-right';
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={4}
      style={({ pressed, hovered }: PressState) => [
        styles.arrow,
        (pressed || hovered) && !disabled && { backgroundColor: colors.pressed },
      ]}>
      <MaterialCommunityIcons
        name={icon}
        size={24}
        color={disabled ? colors.textFaint : colors.brand}
      />
    </Pressable>
  );
}

function StepIcon({ journey, step, color }: { journey: Journey; step: TripStep; color: string }) {
  if (step.kind === 'walk') return <ModeIcon mode="walk" size={18} color={color} />;
  if (step.kind === 'ride') {
    const mode = journey.legs[step.leg].mode;
    return <ModeIcon mode={mode} size={18} color={color} />;
  }
  return (
    <MaterialCommunityIcons
      name={step.kind === 'change' ? 'swap-horizontal' : 'flag-checkered'}
      size={18}
      color={color}
    />
  );
}

function StepPage({
  journey,
  step,
  now,
  width,
}: {
  journey: Journey;
  step: TripStep;
  now: number;
  width: number;
}) {
  const text = stepText(journey, step, now);
  const done = step.state === 'done';
  const tone = {
    ok: null,
    warning: { bg: colors.warningBg, fg: colors.warning },
    danger: { bg: colors.delayBg, fg: colors.delay },
  }[text.tone];
  const fg = done ? colors.textMuted : (tone?.fg ?? colors.text);
  return (
    <View
      style={[styles.page, { width: width || undefined }]}
      accessible
      accessibilityLabel={[text.label, text.title, ...text.lines].join('. ')}>
      <View style={[styles.box, tone && { backgroundColor: tone.bg }]}>
        <View style={styles.head}>
          <View style={[styles.chip, chipStyle(step.state)]}>
            <Text style={[styles.chipText, chipTextStyle(step.state)]}>{text.label}</Text>
          </View>
          <StepIcon journey={journey} step={step} color={fg} />
          {text.line ? <LinePill line={text.line} size="sm" /> : null}
        </View>
        <Text style={[styles.title, { color: fg }]}>{text.title}</Text>
        {text.lines.map((l, i) => (
          <Text key={i} style={[styles.line, tone && !done && { color: tone.fg }]}>
            {l}
          </Text>
        ))}
      </View>
    </View>
  );
}

function chipStyle(state: StepState) {
  return {
    now: styles.chipNow,
    next: styles.chipNext,
    done: styles.chipDone,
    later: styles.chipLater,
  }[state];
}

function chipTextStyle(state: StepState) {
  return {
    now: { color: colors.brandDark },
    next: { color: colors.brand },
    done: { color: colors.textMuted },
    later: { color: colors.textMuted },
  }[state];
}

const styles = themed(() =>
  StyleSheet.create({
    wrap: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: space.sm,
    },
    heading: { ...type.label, color: colors.textMuted, paddingHorizontal: space.lg },
    page: { paddingHorizontal: space.lg, paddingTop: space.sm },
    box: {
      backgroundColor: colors.bg,
      borderRadius: radius.md,
      padding: space.md,
      gap: space.xs,
      flex: 1,
      minHeight: 112,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    chip: { borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
    chipNow: { backgroundColor: colors.accent },
    chipNext: { backgroundColor: colors.brandTint },
    chipDone: { backgroundColor: colors.scheduledBg },
    chipLater: { borderWidth: 1, borderColor: colors.border },
    chipText: { ...type.smallStrong },
    title: { ...type.bodyStrong },
    line: { ...type.small, color: colors.textMuted },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.sm,
    },
    arrow: {
      width: 44,
      height: 44,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dots: { flexDirection: 'row', gap: 6, alignItems: 'center', flexShrink: 1, flexWrap: 'wrap' },
    dot: {
      width: 8,
      height: 8,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.textFaint,
    },
    dotDone: { backgroundColor: colors.textFaint },
    dotNow: { backgroundColor: colors.accent, borderColor: colors.accent },
    dotOn: { width: 20, borderColor: colors.brand },
  }),
);
