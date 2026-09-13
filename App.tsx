import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { getBackendHealth } from './src/api/courseBackend';
import { IncidentListScreen } from './src/campusops/ui/IncidentListScreen';
import { IncidentDetailScreen } from './src/campusops/ui/IncidentDetailScreen';
import { GetIncidentsUseCase } from './src/campusops/application/GetIncidentsUseCase';
import { GetIncidentDetailUseCase } from './src/campusops/application/GetIncidentDetailUseCase';
import { incidentRepository } from './src/campusops/infrastructure/InMemoryIncidentRepository';

const getIncidentsUseCase = new GetIncidentsUseCase(incidentRepository);
const getIncidentDetailUseCase = new GetIncidentDetailUseCase(incidentRepository);

export default function App() {
  const [status, setStatus] = useState<'checking' | 'available' | 'offline'>('checking');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getBackendHealth()
      .then(() => active && setStatus('available'))
      .catch(() => active && setStatus('offline'));
    return () => {
      active = false;
    };
  }, []);

  return (
    <View style={styles.screen}>
      <View accessibilityRole="summary" style={styles.card}>
        <Text style={styles.title}>CampusOps</Text>
        <Text>Incidencias del campus · entorno académico ficticio</Text>
        <Text testID="backend-status">Backend: {status}</Text>
      </View>
      <View style={styles.content}>
        {status === 'checking' ? (
          <Text>Conectando con el backend...</Text>
        ) : selectedIncidentId ? (
          <IncidentDetailScreen
            incidentId={selectedIncidentId}
            onBack={() => setSelectedIncidentId(null)}
            getIncidentDetailUseCase={getIncidentDetailUseCase}
          />
        ) : (
          <IncidentListScreen
            onSelectIncident={(id) => setSelectedIncidentId(id)}
            getIncidentsUseCase={getIncidentsUseCase}
          />
        )}
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f0f0f0', paddingTop: 48 },
  card: { gap: 12, padding: 20, backgroundColor: 'white', borderBottomWidth: 1, borderColor: '#ddd' },
  title: { fontSize: 24, fontWeight: '700' },
  content: { flex: 1 }
});
