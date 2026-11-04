import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { IncidentListScreen } from '../src/campusops/ui/IncidentListScreen';
import { IncidentDetailScreen } from '../src/campusops/ui/IncidentDetailScreen';
import { GetIncidentsUseCase } from '../src/campusops/application/GetIncidentsUseCase';
import { GetIncidentDetailUseCase } from '../src/campusops/application/GetIncidentDetailUseCase';
import { Incident } from '../src/campusops/domain/Incident';

const dummyIncident: Incident = {
  id: 'campus-inc-101',
  version: 1,
  title: 'Fuga de agua en Laboratorio 3',
  description: 'Tubería principal rota en el área de lavado',
  category: 'water',
  location: { source: 'manual', label: 'Edificio B - Lab 3' },
  work: { status: 'assigned', assignedTechnicianId: 'technician-1' },
};

describe('Semana 10 — UI State Machine & Accessible Incident Screens', () => {
  test('IncidentListScreen renders accessible loading state and allows cancellation', async () => {
    // Caso de uso que nunca resuelve inmediatamente para observar loading
    const useCase = new GetIncidentsUseCase({
      list: () => new Promise(() => {}),
    });

    const onCancelMock = jest.fn();
    const view = await render(
      <IncidentListScreen
        onSelectIncident={jest.fn()}
        getIncidentsUseCase={useCase}
        onCancel={onCancelMock}
      />
    );

    // Verifica que existe indicador de progreso accesible
    expect(view.getByTestId('incident-list-loading')).toBeTruthy();
    expect(view.getByLabelText('Cargando lista de incidencias')).toBeTruthy();

    // Pulsa cancelar para evitar espera perpetua
    const cancelButton = view.getByTestId('cancel-load-button');
    fireEvent.press(cancelButton);

    expect(onCancelMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(view.getByText('Carga cancelada por el usuario.')).toBeTruthy();
    });
  });

  test('IncidentListScreen renders success state with accessible items and location', async () => {
    const useCase = new GetIncidentsUseCase({
      list: async () => ({ kind: 'success' as const, value: [dummyIncident] }),
    });

    const onSelectMock = jest.fn();
    const view = await render(
      <IncidentListScreen
        onSelectIncident={onSelectMock}
        getIncidentsUseCase={useCase}
      />
    );

    await waitFor(() => {
      expect(view.getByText('Fuga de agua en Laboratorio 3')).toBeTruthy();
    });

    expect(view.getByText('📍 Edificio B - Lab 3')).toBeTruthy();

    // Selecciona el elemento
    fireEvent.press(view.getByText('Fuga de agua en Laboratorio 3'));
    expect(onSelectMock).toHaveBeenCalledWith('campus-inc-101');
  });

  test('IncidentListScreen renders accessible empty state when items list is empty', async () => {
    const useCase = new GetIncidentsUseCase({
      list: async () => ({ kind: 'success' as const, value: [] }),
    });

    const view = await render(
      <IncidentListScreen
        onSelectIncident={jest.fn()}
        getIncidentsUseCase={useCase}
      />
    );

    await waitFor(() => {
      expect(view.getByTestId('incident-list-message')).toHaveTextContent('No hay incidencias.');
    });
  });

  test('IncidentListScreen renders recoverable error with working retry action', async () => {
    let callCount = 0;
    const useCase = new GetIncidentsUseCase({
      list: async () => {
        callCount++;
        if (callCount === 1) {
          return { kind: 'error' as const, code: 'timeout' };
        }
        return { kind: 'success' as const, value: [dummyIncident] };
      },
    });

    const view = await render(
      <IncidentListScreen
        onSelectIncident={jest.fn()}
        getIncidentsUseCase={useCase}
      />
    );

    await waitFor(() => {
      expect(view.getByTestId('incident-list-message')).toHaveTextContent('Tiempo de espera agotado.');
    });

    // Ejecuta reintento
    const retryButton = view.getByText('Reintentar');
    fireEvent.press(retryButton);

    await waitFor(() => {
      expect(view.getByText('Fuga de agua en Laboratorio 3')).toBeTruthy();
    });
    expect(callCount).toBe(2);
  });

  test('IncidentListScreen reflects offline, pending sync, and conflict states', async () => {
    const useCase = new GetIncidentsUseCase({
      list: async () => ({ kind: 'success' as const, value: [dummyIncident] }),
    });

    const view = await render(
      <IncidentListScreen
        onSelectIncident={jest.fn()}
        getIncidentsUseCase={useCase}
        isOffline={true}
        pendingCount={3}
        conflictNotice="Reasignación remota detectada en campus-inc-101"
      />
    );

    await waitFor(() => {
      expect(view.getByTestId('offline-indicator')).toBeTruthy();
      expect(view.getByTestId('pending-sync-badge')).toBeTruthy();
      expect(view.getByTestId('conflict-banner')).toBeTruthy();
    });

    expect(view.getByText(/Modo sin conexión/)).toBeTruthy();
    expect(view.getByText(/3 operación\(es\) pendiente\(s\)/)).toBeTruthy();
    expect(view.getByText(/Conflicto detectado: Reasignación remota/)).toBeTruthy();
  });

  test('IncidentDetailScreen renders loading, error recovery, and success details', async () => {
    let detailCalls = 0;
    const detailUseCase = new GetIncidentDetailUseCase({
      detail: async () => {
        detailCalls++;
        if (detailCalls === 1) {
          return { kind: 'error' as const, code: 'server', status: 500 };
        }
        return { kind: 'success' as const, value: dummyIncident };
      },
    });

    const onBackMock = jest.fn();
    const view = await render(
      <IncidentDetailScreen
        incidentId="campus-inc-101"
        onBack={onBackMock}
        getIncidentDetailUseCase={detailUseCase}
        isOffline={true}
        hasPendingChange={true}
      />
    );

    // Primer intento: error 500
    await waitFor(() => {
      expect(view.getByTestId('incident-detail-error')).toBeTruthy();
      expect(view.getByText('Error del servidor (500).')).toBeTruthy();
    });

    // Reintentar
    fireEvent.press(view.getByText('Reintentar'));

    // Segundo intento: detalle con éxito
    await waitFor(() => {
      expect(view.getByText('Fuga de agua en Laboratorio 3')).toBeTruthy();
    });

    expect(view.getByText(/technician-1/)).toBeTruthy();
    expect(view.getByTestId('detail-offline-badge')).toBeTruthy();
    expect(view.getByTestId('detail-pending-badge')).toBeTruthy();

    // Botón volver
    fireEvent.press(view.getByText('← Volver'));
    expect(onBackMock).toHaveBeenCalledTimes(1);
  });
});
