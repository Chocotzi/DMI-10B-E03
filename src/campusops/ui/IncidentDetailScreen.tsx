import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Button } from 'react-native';
import { Incident } from '../domain/Incident';
import { GetIncidentDetailUseCase } from '../application/GetIncidentDetailUseCase';

type Props = {
  incidentId: string;
  onBack: () => void;
  getIncidentDetailUseCase: GetIncidentDetailUseCase;
  isOffline?: boolean;
  hasPendingChange?: boolean;
  conflictDetails?: string | null;
};

export const IncidentDetailScreen: React.FC<Props> = ({
  incidentId,
  onBack,
  getIncidentDetailUseCase,
  isOffline = false,
  hasPendingChange = false,
  conflictDetails = null,
}) => {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let mounted = true;

    getIncidentDetailUseCase.execute(incidentId).then(result => {
      if (!mounted) return;
      setLoading(false);
      if (result.kind === 'success') {
        setIncident(result.value);
      } else if (result.kind === 'empty') {
        setMessage('La incidencia no tiene datos disponibles.');
      } else {
        setMessage(
          result.code === 'timeout'
            ? 'Tiempo de espera agotado.'
            : result.code === 'server'
            ? 'Error del servidor (500).'
            : result.code === 'invalid_contract'
            ? 'Contrato inválido.'
            : 'No se pudo cargar la incidencia.'
        );
      }
    });

    return () => {
      mounted = false;
    };
  }, [getIncidentDetailUseCase, incidentId, reload]);

  const handleRetry = () => {
    setLoading(true);
    setMessage(null);
    setReload(r => r + 1);
  };

  if (loading) {
    return (
      <View style={styles.container} testID="incident-detail-loading">
        <TouchableOpacity
          style={styles.backButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Cancelar carga y volver a la lista"
        >
          <Text style={styles.backButtonText}>← Cancelar y Volver</Text>
        </TouchableOpacity>
        <View style={styles.loaderContainer}>
          <ActivityIndicator
            style={styles.loader}
            size="large"
            color="#0000ff"
            accessibilityRole="progressbar"
            accessibilityLabel="Cargando detalle de la incidencia"
          />
          <Text style={styles.loadingText}>Cargando información de la incidencia...</Text>
        </View>
      </View>
    );
  }

  if (!incident) {
    return (
      <View style={styles.container}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Volver a la lista de incidencias"
        >
          <Text style={styles.backButtonText}>← Volver</Text>
        </TouchableOpacity>
        <View style={styles.errorCard} testID="incident-detail-error">
          <Text style={styles.errorText} accessibilityRole="alert">
            {message ?? 'Incidencia no encontrada.'}
          </Text>
          <View style={styles.retryButtonRow}>
            <Button
              title="Reintentar"
              onPress={handleRetry}
              accessibilityLabel="Reintentar carga de la incidencia"
            />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.backButton}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Volver a la lista de incidencias"
      >
        <Text style={styles.backButtonText}>← Volver</Text>
      </TouchableOpacity>

      {/* Indicadores de estado de red y sincronización */}
      {isOffline && (
        <View style={styles.offlineBadge} testID="detail-offline-badge" accessibilityRole="text" accessibilityLabel="Modo sin conexión">
          <Text style={styles.offlineBadgeText}>📡 Visualizando datos cacheados localmente</Text>
        </View>
      )}

      {hasPendingChange && (
        <View style={styles.pendingBadge} testID="detail-pending-badge" accessibilityRole="text" accessibilityLabel="Cambios locales pendientes">
          <Text style={styles.pendingBadgeText}>⏳ Modificaciones pendientes de sincronizar en esta incidencia</Text>
        </View>
      )}

      {conflictDetails && (
        <View style={styles.conflictCard} testID="detail-conflict-badge" accessibilityRole="alert" accessibilityLabel={`Conflicto: ${conflictDetails}`}>
          <Text style={styles.conflictCardText}>⚠️ Conflicto detectado en la asignación: {conflictDetails}</Text>
        </View>
      )}

      {/* Tarjeta accesible de detalle de incidencia */}
      <View style={styles.card} accessibilityRole="summary">
        <Text style={styles.title} accessibilityRole="header">
          {incident.title}
        </Text>
        <Text style={styles.text} accessibilityLabel={`Identificador: ${incident.id}`}>
          <Text style={styles.bold}>ID:</Text> {incident.id}
        </Text>
        <Text style={styles.text} accessibilityLabel={`Categoría: ${incident.category}`}>
          <Text style={styles.bold}>Categoría:</Text> {incident.category}
        </Text>
        <Text style={styles.text} accessibilityLabel={`Estado: ${incident.work.status}`}>
          <Text style={styles.bold}>Estado:</Text> {incident.work.status}
        </Text>
        <Text style={styles.text} accessibilityLabel={`Ubicación: ${incident.location.label}`}>
          <Text style={styles.bold}>Ubicación:</Text> {incident.location.label}
        </Text>
        <Text
          style={styles.text}
          accessibilityLabel={`Técnico asignado: ${incident.work.assignedTechnicianId || 'Ninguno'}`}
        >
          <Text style={styles.bold}>Técnico asignado:</Text> {incident.work.assignedTechnicianId || 'Ninguno'}
        </Text>
        <Text style={styles.descriptionHeader} accessibilityRole="header">
          Descripción:
        </Text>
        <Text style={styles.description} accessibilityLabel={incident.description}>
          {incident.description}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f8fafc' },
  loaderContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 },
  loader: { marginBottom: 8 },
  loadingText: { fontSize: 14, color: '#64748b' },
  errorCard: { padding: 20, backgroundColor: '#ffffff', borderRadius: 10, borderWidth: 1, borderColor: '#fecaca', marginTop: 20 },
  errorText: { fontSize: 15, color: '#dc2626', textAlign: 'center', marginBottom: 12 },
  retryButtonRow: { alignItems: 'center' },
  backButton: { paddingVertical: 10, paddingHorizontal: 16, backgroundColor: '#2563eb', borderRadius: 8, alignSelf: 'flex-start', marginBottom: 14 },
  backButtonText: { color: '#ffffff', fontWeight: 'bold', fontSize: 15 },
  offlineBadge: { padding: 8, backgroundColor: '#fef3c7', borderRadius: 6, marginBottom: 10, borderWidth: 1, borderColor: '#fde68a' },
  offlineBadgeText: { color: '#92400e', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  pendingBadge: { padding: 8, backgroundColor: '#e0e7ff', borderRadius: 6, marginBottom: 10, borderWidth: 1, borderColor: '#c7d2fe' },
  pendingBadgeText: { color: '#3730a3', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  conflictCard: { padding: 10, backgroundColor: '#fee2e2', borderRadius: 6, marginBottom: 10, borderWidth: 1, borderColor: '#fecaca' },
  conflictCardText: { color: '#991b1b', fontSize: 13, fontWeight: 'bold', textAlign: 'center' },
  card: { padding: 20, backgroundColor: '#ffffff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
  title: { fontSize: 20, fontWeight: 'bold', marginBottom: 14, color: '#0f172a' },
  text: { fontSize: 15, marginBottom: 8, color: '#334155' },
  bold: { fontWeight: '700', color: '#0f172a' },
  descriptionHeader: { fontSize: 14, fontWeight: '700', marginTop: 12, color: '#0f172a' },
  description: { fontSize: 14, marginTop: 4, fontStyle: 'italic', color: '#475569', lineHeight: 20 },
});
