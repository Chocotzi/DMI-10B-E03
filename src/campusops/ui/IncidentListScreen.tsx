import React, { useEffect, useState, useRef } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Button, TextInput } from 'react-native';
import { Incident } from '../domain/Incident';
import { GetIncidentsUseCase } from '../application/GetIncidentsUseCase';

type Props = {
  onSelectIncident: (id: string) => void;
  getIncidentsUseCase: GetIncidentsUseCase;
  createIncident?: (input: { category: 'water'; description: string; location: string; idempotencyKey: string }) => Promise<{ kind: string }>;
  isOffline?: boolean;
  pendingCount?: number;
  conflictNotice?: string | null;
  onCancel?: () => void;
};

let creationSequence = 0;

export const IncidentListScreen: React.FC<Props> = ({
  onSelectIncident,
  getIncidentsUseCase,
  createIncident,
  isOffline = false,
  pendingCount = 0,
  conflictNotice = null,
  onCancel,
}) => {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const idempotencyKey = useRef(`incident-${++creationSequence}`);

  useEffect(() => {
    let mounted = true;

    getIncidentsUseCase.execute().then(result => {
      if (!mounted) return;
      setLoading(false);
      if (result.kind === 'success') {
        setIncidents([...result.value]);
        setMessage(result.value.length ? null : 'No hay incidencias.');
      } else if (result.kind === 'empty') {
        setMessage('No hay incidencias.');
      } else {
        setMessage(
          result.code === 'timeout'
            ? 'Tiempo de espera agotado.'
            : result.code === 'server'
            ? 'Error del servidor (500).'
            : result.code === 'invalid_contract'
            ? 'Respuesta inválida del servidor.'
            : 'No se pudieron cargar las incidencias.'
        );
      }
    });

    return () => {
      mounted = false;
    };
  }, [getIncidentsUseCase, reload]);

  const handleCancel = () => {
    setLoading(false);
    setMessage('Carga cancelada por el usuario.');
    if (onCancel) onCancel();
  };

  const handleRetry = () => {
    setLoading(true);
    setMessage(null);
    setReload(value => value + 1);
  };

  return (
    <View style={styles.container} accessibilityRole="none">
      {/* Encabezado accesible */}
      <Text style={styles.header} accessibilityRole="header">
        Incidencias
      </Text>

      {/* Indicador de modo sin conexión (Offline) */}
      {isOffline && (
        <View style={styles.offlineBanner} testID="offline-indicator" accessibilityRole="text" accessibilityLabel="Aviso: Modo sin conexión activo. Se muestran datos locales.">
          <Text style={styles.offlineText}>📡 Modo sin conexión — consulta local disponible</Text>
        </View>
      )}

      {/* Indicador de cambios pendientes en cola */}
      {pendingCount > 0 && (
        <View style={styles.pendingBadge} testID="pending-sync-badge" accessibilityRole="text" accessibilityLabel={`${pendingCount} cambios pendientes de sincronizar`}>
          <Text style={styles.pendingText}>⏳ {pendingCount} operación(es) pendiente(s) de sincronizar</Text>
        </View>
      )}

      {/* Alerta accesible de conflicto de sincronización */}
      {conflictNotice && (
        <View style={styles.conflictBanner} testID="conflict-banner" accessibilityRole="alert" accessibilityLabel={`Conflicto de sincronización: ${conflictNotice}`}>
          <Text style={styles.conflictText}>⚠️ Conflicto detectado: {conflictNotice}</Text>
        </View>
      )}

      {/* Estado de carga con opción de cancelación */}
      {loading ? (
        <View style={styles.loaderContainer} testID="incident-list-loading">
          <ActivityIndicator
            style={styles.loader}
            size="large"
            color="#0000ff"
            accessibilityRole="progressbar"
            accessibilityLabel="Cargando lista de incidencias"
          />
          <Text style={styles.loadingText}>Cargando incidencias del campus...</Text>
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={handleCancel}
            testID="cancel-load-button"
            accessibilityRole="button"
            accessibilityLabel="Cancelar carga de incidencias"
          >
            <Text style={styles.cancelButtonText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Mensajes de error o estado cancelado */}
          {message && (
            <View style={styles.messageContainer}>
              <Text
                testID="incident-list-message"
                style={message === 'No hay incidencias.' ? styles.emptyText : styles.errorText}
                accessibilityRole={message === 'No hay incidencias.' ? 'text' : 'alert'}
                accessibilityLabel={message}
              >
                {message}
              </Text>
              <Button
                title="Reintentar"
                onPress={handleRetry}
                accessibilityLabel="Reintentar carga de incidencias"
              />
            </View>
          )}

          {/* Formulario de creación con accesibilidad */}
          {createIncident && (
            <View style={styles.createBox} accessibilityRole="none">
              <Text style={styles.createTitle} accessibilityRole="header">Nueva Incidencia</Text>
              <TextInput
                style={styles.input}
                accessibilityLabel="Descripción de la incidencia"
                accessibilityHint="Ingresa una breve descripción de la avería encontrada"
                placeholder="Descripción"
                value={description}
                onChangeText={setDescription}
              />
              <TextInput
                style={styles.input}
                accessibilityLabel="Ubicación de la incidencia"
                accessibilityHint="Ingresa el edificio, zona o referencia del campus"
                placeholder="Ubicación"
                value={location}
                onChangeText={setLocation}
              />
              <Button
                title="Crear incidencia"
                accessibilityLabel="Enviar reporte de incidencia"
                onPress={async () => {
                  const result = await createIncident({
                    category: 'water',
                    description,
                    location,
                    idempotencyKey: idempotencyKey.current,
                  });
                  setCreateMessage(result.kind === 'success' ? 'Incidencia creada.' : 'No se pudo crear la incidencia.');
                }}
              />
              {createMessage && (
                <Text style={styles.createFeedback} accessibilityRole="alert">
                  {createMessage}
                </Text>
              )}
            </View>
          )}

          {/* Listado de incidencias con roles y etiquetas accesibles */}
          <FlatList
            data={incidents}
            keyExtractor={item => item.id}
            accessibilityRole="list"
            contentContainerStyle={incidents.length === 0 ? styles.emptyListContent : undefined}
            ListEmptyComponent={
              !message ? (
                <View testID="incident-list-empty" style={styles.emptyContainer}>
                  <Text style={styles.emptyText} accessibilityRole="text">
                    No hay incidencias registradas en este momento.
                  </Text>
                  <Button title="Refrescar" onPress={handleRetry} accessibilityLabel="Refrescar lista" />
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.card}
                onPress={() => onSelectIncident(item.id)}
                accessibilityRole="button"
                accessibilityLabel={`Incidencia: ${item.title}. Estado: ${item.work.status}. Categoría: ${item.category}. Ubicación: ${item.location.label}`}
                accessibilityHint="Toca dos veces para ver el detalle completo de esta incidencia"
              >
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.subtitle}>
                  Estado: <Text style={styles.bold}>{item.work.status}</Text> | Categoría: {item.category}
                </Text>
                <Text style={styles.locationText}>📍 {item.location.label}</Text>
              </TouchableOpacity>
            )}
          />
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f8fafc' },
  header: { fontSize: 22, fontWeight: 'bold', marginBottom: 12, color: '#0f172a' },
  loaderContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loader: { marginBottom: 8 },
  loadingText: { fontSize: 14, color: '#475569' },
  cancelButton: { marginTop: 12, paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#e2e8f0', borderRadius: 6 },
  cancelButtonText: { color: '#334155', fontWeight: '600' },
  offlineBanner: { padding: 10, backgroundColor: '#fef3c7', borderRadius: 8, marginBottom: 10, borderWidth: 1, borderColor: '#fde68a' },
  offlineText: { color: '#92400e', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  pendingBadge: { padding: 8, backgroundColor: '#e0e7ff', borderRadius: 8, marginBottom: 10, borderWidth: 1, borderColor: '#c7d2fe' },
  pendingText: { color: '#3730a3', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  conflictBanner: { padding: 10, backgroundColor: '#fee2e2', borderRadius: 8, marginBottom: 10, borderWidth: 1, borderColor: '#fecaca' },
  conflictText: { color: '#991b1b', fontSize: 13, fontWeight: 'bold', textAlign: 'center' },
  messageContainer: { padding: 12, marginBottom: 12, backgroundColor: '#ffffff', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  errorText: { padding: 8, color: '#b91c1c', fontSize: 14, fontWeight: '500', textAlign: 'center', marginBottom: 6 },
  emptyContainer: { padding: 24, alignItems: 'center', justifyContent: 'center' },
  emptyText: { padding: 12, color: '#64748b', fontSize: 14, textAlign: 'center' },
  emptyListContent: { flexGrow: 1, justifyContent: 'center' },
  createBox: { backgroundColor: '#ffffff', padding: 14, borderRadius: 8, marginBottom: 14, borderWidth: 1, borderColor: '#cbd5e1' },
  createTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8, color: '#1e293b' },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 6, padding: 8, marginBottom: 8, backgroundColor: '#f8fafc' },
  createFeedback: { marginTop: 8, color: '#047857', fontWeight: '600', textAlign: 'center' },
  card: { padding: 16, backgroundColor: '#ffffff', marginBottom: 12, borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2 },
  title: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 13, color: '#475569', marginTop: 4 },
  locationText: { fontSize: 12, color: '#64748b', marginTop: 4 },
  bold: { fontWeight: '700' },
});
