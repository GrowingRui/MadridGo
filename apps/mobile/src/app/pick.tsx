// Stop picker page for the Departures tab (field=board). The planner searches in place instead;
// field=from|to still works for deep links.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { BrandHeader, Screen } from '../components/layout';
import { StopSuggestions } from '../components/stopSearch';
import { type MessageKey, useT } from '../i18n';
import { setPlanner } from '../state/planner';
import { type SavedStop, addRecent } from '../state/saved';
import { colors, radius, space, type } from '../theme';

const TITLES: Record<string, MessageKey> = {
  from: 'pick.from',
  to: 'pick.to',
  board: 'pick.board',
};

export default function PickScreen() {
  const { field = 'to' } = useLocalSearchParams<{ field?: 'from' | 'to' | 'board' }>();
  const [text, setText] = useState('');
  const { t } = useT();

  const choose = (s: SavedStop) => {
    addRecent(s);
    if (field === 'board') {
      router.replace({ pathname: '/stop/[id]', params: { id: s.id } });
      return;
    }
    setPlanner({ [field]: { id: s.id, name: s.name } });
    router.back();
  };

  return (
    <Screen
      header={
        <BrandHeader title={t(TITLES[field] ?? 'pick.stop')} onBack={() => router.back()}>
          <View style={styles.search}>
            <MaterialCommunityIcons name="magnify" size={22} color={colors.textMuted} />
            <TextInput
              autoFocus
              value={text}
              onChangeText={setText}
              placeholder={t('search.placeholder')}
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel={t('search.label')}
            />
            {text ? (
              <MaterialCommunityIcons
                name="close-circle"
                size={20}
                color={colors.textFaint}
                onPress={() => setText('')}
                accessibilityLabel={t('common.clear')}
              />
            ) : null}
          </View>
        </BrandHeader>
      }>
      <StopSuggestions text={text} onPick={choose} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    marginTop: space.lg,
  },
  // outlineWidth 0: the whole search box is the focus target; the browser ring looked broken.
  input: { flex: 1, ...type.body, color: colors.text, paddingVertical: 12, outlineWidth: 0 },
});
