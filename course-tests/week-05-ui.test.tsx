import { render, waitFor } from '@testing-library/react-native';
import { IncidentListScreen } from '../src/campusops/ui/IncidentListScreen';
import { GetIncidentsUseCase } from '../src/campusops/application/GetIncidentsUseCase';

test('lista sale de carga y muestra error recuperable', async () => {
  const useCase = new GetIncidentsUseCase({ list: async () => ({ kind: 'error' as const, code: 'server', status: 500 }) });
  const view = await render(<IncidentListScreen onSelectIncident={jest.fn()} getIncidentsUseCase={useCase} />);
  await waitFor(() => expect(view.getByTestId('incident-list-message')).toHaveTextContent('Error del servidor (500).'));
  expect(view.getByText('Reintentar')).toBeTruthy();
});
