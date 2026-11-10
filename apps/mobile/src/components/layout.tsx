// Layout primitives: screen scaffold with the navy brand header, cards, sections and states.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useIsWide } from '../hooks';
import { useT } from '../i18n';
import { colors, MAX_CONTENT_WIDTH, radius, space, type, WIDE_MAX_WIDTH } from '../theme';
import { Footer } from './nav';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

/** Centres content and caps its width so the website reads well on wide screens. */
export function Constrained({
  children,
  style,
  wide,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Use the full website width (planner, split views) instead of the reading width. */
  wide?: boolean;
}) {
  return (
    <View style={[styles.constrained, wide && { maxWidth: WIDE_MAX_WIDTH }, style]}>
      {children}
    </View>
  );
}

export function Screen({
  header,
  children,
  refreshing,
  onRefresh,
  wide,
  fill,
}: {
  header?: ReactNode;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  wide?: boolean;
  /** The body fills the space under the header and does not scroll (the map). */
  fill?: boolean;
}) {
  const isWide = useIsWide();
  if (fill) {
    return (
      <View style={styles.screen}>
        {header}
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    );
  }
  return (
    <View style={styles.screen}>
      {/* In the app the header stays fixed; on the website it scrolls with the page. */}
      {isWide ? null : header}
      <ScrollView
        contentContainerStyle={[styles.scroll, isWide && styles.scrollWide]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined
        }>
        {isWide ? header : null}
        <Constrained wide={wide && isWide} style={isWide && styles.bodyWide}>
          {children}
        </Constrained>
        {isWide ? <Footer /> : null}
      </ScrollView>
    </View>
  );
}

/** Navy header band. Tab screens show a large title; pushed screens a back button. */
export function BrandHeader({
  title,
  subtitle,
  onBack,
  right,
  children,
  wide,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
  children?: ReactNode;
  wide?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const isWide = useIsWide();
  const { t } = useT();
  return (
    <View
      style={[styles.header, { paddingTop: insets.top + space.md }, isWide && styles.headerWide]}>
      <Constrained
        wide={wide && isWide}
        style={[styles.headerInner, isWide && styles.headerInnerWide]}>
        {title || onBack || right ? (
          <View style={styles.headerTop}>
            {onBack ? (
              <Pressable
                onPress={onBack}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
                hitSlop={12}
                style={styles.back}>
                <MaterialCommunityIcons name="arrow-left" size={24} color={colors.onBrand} />
              </Pressable>
            ) : null}
            <View style={styles.headerTitles}>
              {title ? (
                <Text
                  style={[onBack ? styles.titleSmall : styles.title]}
                  accessibilityRole="header"
                  numberOfLines={2}>
                  {title}
                </Text>
              ) : null}
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>
            {right}
          </View>
        ) : null}
        {children}
      </Constrained>
    </View>
  );
}

export function HeaderIconButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={10}>
      <MaterialCommunityIcons name={icon} size={24} color={colors.onBrand} />
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionText} accessibilityRole="header">
        {children}
      </Text>
      {action}
    </View>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  return <View style={[styles.divider, { marginLeft: inset }]} />;
}

export function Loading({ label }: { label?: string }) {
  const { t } = useT();
  return (
    <View style={styles.state}>
      <ActivityIndicator color={colors.brand} />
      <Text style={styles.stateText}>{label ?? t('common.loading')}</Text>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.state}>
      <MaterialCommunityIcons name={icon} size={40} color={colors.textFaint} />
      <Text style={styles.stateTitle}>{title}</Text>
      {body ? <Text style={styles.stateText}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <EmptyState
      icon="cloud-off-outline"
      title={t('common.errorTitle')}
      body={message}
      action={
        onRetry ? (
          <Button label={t('common.retry')} onPress={onRetry} variant="secondary" />
        ) : undefined
      }
    />
  );
}

export function Notice({
  tone = 'warning',
  icon = 'alert-outline',
  title,
  children,
}: {
  tone?: 'warning' | 'info' | 'danger';
  icon?: IconName;
  title?: string;
  children: ReactNode;
}) {
  const palette = {
    warning: { bg: colors.warningBg, fg: colors.warning },
    info: { bg: colors.brandTint, fg: colors.brand },
    danger: { bg: colors.delayBg, fg: colors.delay },
  }[tone];
  return (
    <View style={[styles.notice, { backgroundColor: palette.bg }]} accessibilityRole="alert">
      <MaterialCommunityIcons name={icon} size={20} color={palette.fg} />
      <View style={{ flex: 1 }}>
        {title ? <Text style={[type.smallStrong, { color: palette.fg }]}>{title}</Text> : null}
        <Text style={[type.small, { color: colors.text }]}>{children}</Text>
      </View>
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'onBrand';
  icon?: IconName;
  disabled?: boolean;
}) {
  const v = disabled
    ? variant === 'onBrand'
      ? { bg: 'transparent', fg: colors.onBrandMuted, border: colors.onBrandMuted }
      : { bg: colors.scheduledBg, fg: colors.textFaint, border: colors.border }
    : {
        primary: { bg: colors.brand, fg: colors.onBrand, border: colors.brand },
        secondary: { bg: colors.surface, fg: colors.brand, border: colors.border },
        onBrand: { bg: colors.accent, fg: colors.brandDark, border: colors.accent },
      }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: v.bg, borderColor: v.border },
        pressed && !disabled && { opacity: 0.8 },
      ]}>
      {icon ? <MaterialCommunityIcons name={icon} size={20} color={v.fg} /> : null}
      <Text style={[type.bodyStrong, { color: v.fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: space.xxl, flexGrow: 1 },
  scrollWide: { paddingBottom: 0 },
  bodyWide: { flexGrow: 1, paddingTop: space.sm },
  constrained: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center' },
  header: { backgroundColor: colors.brand, paddingBottom: space.lg },
  headerInner: { paddingHorizontal: space.lg },
  // zIndex: the planner's suggestion dropdown overlaps the page below the band.
  headerWide: { paddingTop: space.xl, paddingBottom: space.xl, zIndex: 10 },
  headerInnerWide: { paddingHorizontal: space.xl },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 32 },
  headerTitles: { flex: 1 },
  back: { marginLeft: -4 },
  title: { ...type.title, color: colors.onBrand },
  titleSmall: { ...type.heading, color: colors.onBrand },
  subtitle: { ...type.small, color: colors.onBrandMuted, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginHorizontal: space.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: space.lg,
    marginTop: space.xl,
    marginBottom: space.sm,
  },
  sectionText: { ...type.label, color: colors.textMuted },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  state: { alignItems: 'center', padding: space.xxl, gap: space.sm },
  stateTitle: { ...type.heading, color: colors.text, textAlign: 'center' },
  stateText: { ...type.small, color: colors.textMuted, textAlign: 'center', maxWidth: 420 },
  notice: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    marginHorizontal: space.lg,
    marginTop: space.md,
  },
  button: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
