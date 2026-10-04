import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { getBackendHealth } from './src/api/courseBackend';
import { IncidentListScreen } from './src/campusops/ui/IncidentListScreen';
import { IncidentDetailScreen } from './src/campusops/ui/IncidentDetailScreen';
import { GetIncidentsUseCase } from './src/campusops/application/GetIncidentsUseCase';
import { GetIncidentDetailUseCase } from './src/campusops/application/GetIncidentDetailUseCase';
import { HttpIncidentClient } from './src/campusops/infrastructure/HttpIncidentClient';
import { setSecureSession } from './src/security/secureSession';
import { CreateIncidentUseCase } from './src/campusops/application/CreateIncidentUseCase';

const client = new HttpIncidentClient({ baseUrl: process.env.EXPO_PUBLIC_COURSE_BACKEND_URL ?? 'http://127.0.0.1:4310', actorId: 'reporter-1', accessToken: 'course-valid-token' });
setSecureSession({ actorId: 'reporter-1', accessToken: 'course-valid-token', expiresAt: Date.now() + 60000 });
const getIncidentsUseCase = new GetIncidentsUseCase(client);
const getIncidentDetailUseCase = new GetIncidentDetailUseCase(client);
const createIncidentUseCase = new CreateIncidentUseCase(client);

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
            createIncident={(input) => createIncidentUseCase.execute(input)}
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
