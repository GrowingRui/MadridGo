import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { type HealthOutcome, fetchHealth, getApiBaseUrl } from './src/api/health';

const COLORS = { ok: '#1B7F4B', degraded: '#B45309', error: '#B42318', text: '#1F2933', muted: '#52606D' };

export default function App() {
  const [outcome, setOutcome] = useState<HealthOutcome | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setOutcome(await fetchHealth());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          MadridGo
        </Text>
        <Text style={styles.subtitle}>Backend status</Text>
        <Text style={styles.muted}>{getApiBaseUrl()}</Text>

        {loading && !outcome ? <ActivityIndicator style={styles.spacer} /> : null}
        {outcome ? <OutcomeView outcome={outcome} /> : null}

        <Pressable
          onPress={refresh}
          disabled={loading}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, (pressed || loading) && styles.buttonPressed]}>
          <Text style={styles.buttonText}>{loading ? 'Checking…' : 'Check again'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function OutcomeView({ outcome }: { outcome: HealthOutcome }) {
  if (outcome.kind === 'unreachable') {
    return (
      <View style={styles.card}>
        <Text style={[styles.badge, { color: COLORS.error }]}>● Unreachable</Text>
        <Text style={styles.muted}>{outcome.reason}</Text>
      </View>
    );
  }
  const { health } = outcome;
  const healthy = outcome.kind === 'healthy';
  return (
    <View style={styles.card}>
      <Text style={[styles.badge, { color: healthy ? COLORS.ok : COLORS.degraded }]}>
        ● {healthy ? 'All systems OK' : 'Degraded'}
      </Text>
      <Text style={styles.muted}>
        API v{health.version} · {health.environment} · checked{' '}
        {new Date(health.checked_at).toLocaleTimeString()}
      </Text>
      {Object.entries(health.checks).map(([name, check]) => (
        <View key={name} style={styles.row}>
          <Text style={styles.rowName}>{name}</Text>
          <Text style={{ color: check.status === 'ok' ? COLORS.ok : COLORS.error }}>
            {check.status === 'ok' ? `ok${check.latency_ms != null ? ` · ${check.latency_ms} ms` : ''}` : 'error'}
          </Text>
          {check.detail ? <Text style={styles.rowDetail}>{check.detail}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F7FA' },
  content: { padding: 24, paddingTop: 72 },
  title: { fontSize: 32, fontWeight: '700', color: COLORS.text },
  subtitle: { fontSize: 18, marginTop: 8, color: COLORS.text },
  muted: { color: COLORS.muted, marginTop: 4 },
  spacer: { marginTop: 24 },
  card: { marginTop: 24, padding: 16, borderRadius: 12, backgroundColor: '#FFFFFF' },
  badge: { fontSize: 18, fontWeight: '600' },
  row: { marginTop: 12 },
  rowName: { fontWeight: '600', color: COLORS.text, textTransform: 'capitalize' },
  rowDetail: { color: COLORS.muted, fontSize: 12 },
  button: { marginTop: 24, padding: 14, borderRadius: 10, backgroundColor: COLORS.text, alignItems: 'center' },
  buttonPressed: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontWeight: '600' },
});
