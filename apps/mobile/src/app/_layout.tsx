import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';

import { TopNav } from '../components/nav';
import { useIsWide } from '../hooks';
import { useLanguage } from '../i18n';
import { useSettings } from '../state/settings';
import { colors } from '../theme';

export default function RootLayout() {
  // Website on a wide screen: white top navigation instead of the app's bottom tab bar.
  const isWide = useIsWide();
  useLanguage(); // loads the stored language choice
  const { appearance: scheme, loaded } = useSettings(); // loads the stored appearance
  // Wait for the stored appearance (a few ms) so the app does not flash light, then dark.
  if (!loaded) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  // The key re-mounts the screens when the scheme changes so every style is read again; the
  // navigation state lives in the router above, so the user stays on the same screen.
  return (
    <View key={scheme} style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={isWide && scheme === 'light' ? 'dark' : 'light'} />
      {isWide ? <TopNav /> : null}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pick" options={{ presentation: isWide ? 'card' : 'modal' }} />
      </Stack>
    </View>
  );
}
