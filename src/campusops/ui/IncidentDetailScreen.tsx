import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Incident } from '../domain/Incident';
import { GetIncidentDetailUseCase } from '../application/GetIncidentDetailUseCase';

type Props = {
  incidentId: string;
  onBack: () => void;
  getIncidentDetailUseCase: GetIncidentDetailUseCase;
};

export const IncidentDetailScreen: React.FC<Props> = ({ incidentId, onBack, getIncidentDetailUseCase }) => {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    getIncidentDetailUseCase.execute(incidentId).then(data => {
      if (mounted) {
        setIncident(data);
        setLoading(false);
      }
    });
    return () => { mounted = false; };
  }, [getIncidentDetailUseCase, incidentId]);

  if (loading) {
    return <ActivityIndicator style={styles.loader} size="large" color="#0000ff" />;
  }

  if (!incident) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Incidencia no encontrada.</Text>
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.backButton} onPress={onBack}>
        <Text style={styles.backButtonText}>← Volver</Text>
      </TouchableOpacity>
      <View style={styles.card}>
        <Text style={styles.title}>{incident.title}</Text>
        <Text style={styles.text}><Text style={styles.bold}>ID:</Text> {incident.id}</Text>
        <Text style={styles.text}><Text style={styles.bold}>Categoría:</Text> {incident.category}</Text>
        <Text style={styles.text}><Text style={styles.bold}>Estado:</Text> {incident.work.status}</Text>
        <Text style={styles.text}><Text style={styles.bold}>Ubicación:</Text> {incident.location.label}</Text>
        <Text style={styles.text}><Text style={styles.bold}>Técnico asignado:</Text> {incident.work.assignedTechnicianId || 'Ninguno'}</Text>
        <Text style={styles.description}>{incident.description}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 16, color: 'red', textAlign: 'center', marginTop: 40 },
  backButton: { paddingVertical: 12, paddingHorizontal: 16, backgroundColor: '#007AFF', borderRadius: 8, alignSelf: 'flex-start', marginBottom: 16 },
  backButtonText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  card: { padding: 20, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#eee', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 3 },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 16, color: '#222' },
  text: { fontSize: 16, marginBottom: 8, color: '#333' },
  bold: { fontWeight: '700', color: '#111' },
  description: { fontSize: 16, marginTop: 16, fontStyle: 'italic', color: '#555', lineHeight: 22 }
});
