import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Tabs } from 'expo-router';
import { Platform } from 'react-native';

import { useIsWide } from '../../hooks';
import { colors } from '../../theme';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

function icon(name: IconName, focusedName: IconName) {
  function TabIcon({ color, focused }: { color: unknown; focused: boolean }) {
    return (
      <MaterialCommunityIcons name={focused ? focusedName : name} size={24} color={String(color)} />
    );
  }
  return TabIcon;
}

export default function TabLayout() {
  const isWide = useIsWide(); // the website uses the top navigation instead
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarStyle: isWide
          ? { display: 'none' }
          : {
              borderTopColor: colors.border,
              backgroundColor: colors.surface,
              // On the web there is no safe-area inset, and the default height clips the labels.
              ...(Platform.OS === 'web' ? { height: 68, paddingTop: 6, paddingBottom: 10 } : null),
            },
      }}>
      <Tabs.Screen
        name="index"
        options={{ title: 'Plan', tabBarIcon: icon('map-marker-path', 'map-marker-path') }}
      />
      <Tabs.Screen
        name="departures"
        options={{ title: 'Departures', tabBarIcon: icon('clock-outline', 'clock') }}
      />
      <Tabs.Screen
        name="saved"
        options={{ title: 'Saved', tabBarIcon: icon('star-outline', 'star') }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: icon('dots-horizontal-circle-outline', 'dots-horizontal-circle'),
        }}
      />
    </Tabs>
  );
}
