import { IncidentRepository } from '../domain/IncidentRepository';
import { Incident } from '../domain/Incident';

const fakeIncidents: Incident[] = [
  {
    id: 'INC-001',
    title: 'Fuga de agua en Laboratorio B',
    description: 'Se reporta una fuga constante debajo del lavabo principal del laboratorio B.',
    category: 'water',
    location: {
      source: 'manual',
      label: 'Edificio Ciencias - Lab B'
    },
    work: {
      assignedTechnicianId: 'tech-123',
      status: 'assigned'
    },
    createdAt: new Date().toISOString()
  },
  {
    id: 'INC-002',
    title: 'Falla eléctrica en Aula 302',
    description: 'Los enchufes de la pared norte no tienen corriente.',
    category: 'electrical',
    location: {
      source: 'manual',
      label: 'Edificio A - Aula 302'
    },
    work: {
      assignedTechnicianId: null,
      status: 'open'
    },
    createdAt: new Date().toISOString()
  }
];

export class InMemoryIncidentRepository implements IncidentRepository {
  async getAll(): Promise<Incident[]> {
    return Promise.resolve([...fakeIncidents]);
  }

  async getById(id: string): Promise<Incident | null> {
    const incident = fakeIncidents.find(i => i.id === id);
    return Promise.resolve(incident || null);
  }
}

export const incidentRepository = new InMemoryIncidentRepository();
