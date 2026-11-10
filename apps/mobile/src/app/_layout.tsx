import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';

import { TopNav } from '../components/nav';
import { useIsWide } from '../hooks';
import { useLanguage } from '../i18n';
import { colors } from '../theme';

export default function RootLayout() {
  // Website on a wide screen: white top navigation instead of the app's bottom tab bar.
  const isWide = useIsWide();
  useLanguage(); // loads the stored language choice
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style={isWide ? 'dark' : 'light'} />
      {isWide ? <TopNav /> : null}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pick" options={{ presentation: isWide ? 'card' : 'modal' }} />
      </Stack>
    </View>
  );
}
