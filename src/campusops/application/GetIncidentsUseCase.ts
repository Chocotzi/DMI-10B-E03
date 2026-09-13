import { Incident } from '../domain/Incident';
import { IncidentRepository } from '../domain/IncidentRepository';

export class GetIncidentsUseCase {
  constructor(private readonly repository: IncidentRepository) {}

  async execute(): Promise<Incident[]> {
    return this.repository.getAll();
  }
}
