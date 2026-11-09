// Website-only chrome: top navigation bar and footer (desktop layout, like a transport
// operator's website). Phones and narrow windows use the bottom tab bar instead.

import { router, usePathname } from 'expo-router';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, space, type, WIDE_MAX_WIDTH } from '../theme';

const LINKS = [
  { label: 'Plan a journey', href: '/' as const },
  { label: 'Departures', href: '/departures' as const },
  { label: 'Saved', href: '/saved' as const },
  { label: 'Data status', href: '/more' as const },
];

function isActive(path: string, href: string) {
  if (href === '/') return path === '/' || path.startsWith('/journey');
  if (href === '/departures') return path.startsWith('/departures') || path.startsWith('/stop');
  return path.startsWith(href);
}

export function TopNav() {
  const path = usePathname();
  return (
    <View style={styles.nav} accessibilityRole="navigation">
      <View style={styles.navInner}>
        <Pressable
          onPress={() => router.navigate('/')}
          accessibilityRole="link"
          accessibilityLabel="MadridGo home"
          style={styles.brand}>
          <Image source={require('../../assets/icon.png')} style={styles.logo} />
          <Text style={styles.wordmark}>MadridGo</Text>
        </Pressable>
        <View style={styles.links}>
          {LINKS.map((l) => {
            const active = isActive(path, l.href);
            return (
              <Pressable
                key={l.href}
                onPress={() => router.navigate(l.href)}
                accessibilityRole="link"
                accessibilityState={{ selected: active }}
                style={({ hovered }) => [
                  styles.link,
                  active && styles.linkActive,
                  hovered && !active && styles.linkHover,
                ]}>
                <Text style={[styles.linkText, active && styles.linkTextActive]}>{l.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

export function Footer() {
  const open = (url: string) => () => void Linking.openURL(url);
  return (
    <View style={styles.footer}>
      <View style={styles.footerInner}>
        <View style={{ flex: 1, gap: space.xs }}>
          <Text style={styles.footerTitle}>MadridGo</Text>
          <Text style={styles.footerText}>
            Reliable journeys across the Community of Madrid. Every time is labelled Live, Scheduled
            or Every ~N min.
          </Text>
        </View>
        <View style={{ gap: space.xs }}>
          <Text style={styles.footerTitle}>Open data</Text>
          <Text style={styles.footerLink} onPress={open('https://www.crtm.es')}>
            Powered by CRTM
          </Text>
          <Text style={styles.footerLink} onPress={open('https://www.emtmadrid.es')}>
            Powered by EMT de Madrid
          </Text>
          <Text style={styles.footerLink} onPress={open('https://data.renfe.com')}>
            Renfe open data (CC BY 4.0)
          </Text>
          <Text style={styles.footerLink} onPress={open('https://www.openstreetmap.org/copyright')}>
            © OpenStreetMap contributors
          </Text>
        </View>
      </View>
      <Text style={styles.footerSmall}>
        MadridGo is independent and not endorsed by CRTM, EMT or Renfe.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  nav: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  navInner: {
    width: '100%',
    maxWidth: WIDE_MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.xl,
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxl,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  logo: { width: 32, height: 32, borderRadius: 8 },
  wordmark: { fontSize: 20, fontWeight: '800', color: colors.brand, letterSpacing: -0.3 },
  links: { flexDirection: 'row', height: '100%', gap: space.xs },
  link: {
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  linkActive: { borderBottomColor: colors.brand },
  linkHover: { borderBottomColor: colors.border },
  linkText: { ...type.bodyStrong, fontSize: 15, color: colors.textMuted },
  linkTextActive: { color: colors.brand },
  footer: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: space.xxl,
    paddingVertical: space.xl,
  },
  footerInner: {
    width: '100%',
    maxWidth: WIDE_MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.xl,
    flexDirection: 'row',
    gap: space.xxl,
  },
  footerTitle: { ...type.smallStrong, color: colors.text },
  footerText: { ...type.small, color: colors.textMuted, maxWidth: 420, lineHeight: 19 },
  footerLink: { ...type.small, color: colors.brand },
  footerSmall: {
    ...type.small,
    color: colors.textFaint,
    width: '100%',
    maxWidth: WIDE_MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.xl,
    marginTop: space.lg,
  },
});
