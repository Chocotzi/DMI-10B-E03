import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Button, TextInput } from 'react-native';
import { Incident } from '../domain/Incident';
import { GetIncidentsUseCase } from '../application/GetIncidentsUseCase';

type Props = {
  onSelectIncident: (id: string) => void;
  getIncidentsUseCase: GetIncidentsUseCase;
  createIncident?: (input: { category: 'water'; description: string; location: string; idempotencyKey: string }) => Promise<{ kind: string }>;
};

let creationSequence = 0;

export const IncidentListScreen: React.FC<Props> = ({ onSelectIncident, getIncidentsUseCase, createIncident }) => {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const idempotencyKey = React.useRef(`incident-${++creationSequence}`);

  useEffect(() => {
    let mounted = true;
    getIncidentsUseCase.execute().then(result => { if (!mounted) return; setLoading(false); if (result.kind === 'success') { setIncidents([...result.value]); setMessage(result.value.length ? null : 'No hay incidencias.'); } else if (result.kind === 'empty') setMessage('No hay incidencias.'); else setMessage(result.code === 'timeout' ? 'Tiempo de espera agotado.' : result.code === 'server' ? 'Error del servidor (500).' : result.code === 'invalid_contract' ? 'Respuesta inválida del servidor.' : 'No se pudieron cargar las incidencias.'); });
    return () => { mounted = false; };
  }, [getIncidentsUseCase, reload]);

  if (loading) {
    return <ActivityIndicator style={styles.loader} size="large" color="#0000ff" />;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Incidencias</Text>
      {message && <><Text testID="incident-list-message" style={styles.errorText}>{message}</Text><Button title="Reintentar" onPress={() => { setLoading(true); setMessage(null); setReload(value => value + 1); }} /></>}
      {createIncident && <View><TextInput accessibilityLabel="Descripción" placeholder="Descripción" value={description} onChangeText={setDescription} /><TextInput accessibilityLabel="Ubicación" placeholder="Ubicación" value={location} onChangeText={setLocation} /><Button title="Crear incidencia" onPress={async () => { const result = await createIncident({ category: 'water', description, location, idempotencyKey: idempotencyKey.current }); setCreateMessage(result.kind === 'success' ? 'Incidencia creada.' : 'No se pudo crear la incidencia.'); }} />{createMessage && <Text>{createMessage}</Text>}</View>}
      <FlatList
        data={incidents}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => onSelectIncident(item.id)}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.subtitle}>Estado: {item.work.status} | Categoría: {item.category}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { fontSize: 20, fontWeight: 'bold', marginBottom: 16, color: '#333' },
  errorText: { padding: 12, color: '#a00' },
  card: { padding: 16, backgroundColor: '#fff', marginBottom: 12, borderRadius: 12, borderWidth: 1, borderColor: '#eee', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 3 },
  title: { fontSize: 16, fontWeight: '600', color: '#111' },
  subtitle: { fontSize: 14, color: '#666', marginTop: 6 }
});
