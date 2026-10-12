import type { Incident } from '../domain/Incident';
import type { ClientResult } from '../domain/IncidentRepository';

export class GetIncidentDetailUseCase {
  constructor(private readonly repository: { detail(id: string): Promise<ClientResult<Incident>> }) {}

  async execute(id: string): Promise<ClientResult<Incident>> {
    return this.repository.detail(id);
  }
}
