import { Incident } from '../domain/Incident';
import { IncidentRepository } from '../domain/IncidentRepository';

export class GetIncidentDetailUseCase {
  constructor(private readonly repository: IncidentRepository) {}

  async execute(id: string): Promise<Incident | null> {
    return this.repository.getById(id);
  }
}
