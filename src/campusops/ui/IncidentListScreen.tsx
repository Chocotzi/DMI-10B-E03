import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Incident } from '../domain/Incident';
import { GetIncidentsUseCase } from '../application/GetIncidentsUseCase';
import { incidentRepository } from '../infrastructure/InMemoryIncidentRepository';

const getIncidentsUseCase = new GetIncidentsUseCase(incidentRepository);

type Props = {
  onSelectIncident: (id: string) => void;
};

export const IncidentListScreen: React.FC<Props> = ({ onSelectIncident }) => {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    getIncidentsUseCase.execute().then(data => {
      if (mounted) {
        setIncidents(data);
        setLoading(false);
      }
    });
    return () => { mounted = false; };
  }, []);

  if (loading) {
    return <ActivityIndicator style={styles.loader} size="large" color="#0000ff" />;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Incidencias (Fake Memory)</Text>
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
  card: { padding: 16, backgroundColor: '#fff', marginBottom: 12, borderRadius: 12, borderWidth: 1, borderColor: '#eee', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 3 },
  title: { fontSize: 16, fontWeight: '600', color: '#111' },
  subtitle: { fontSize: 14, color: '#666', marginTop: 6 }
});
