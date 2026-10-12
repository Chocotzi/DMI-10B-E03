import type { Incident } from '../domain/Incident';
import type { ClientResult } from '../domain/IncidentRepository';

export class GetIncidentsUseCase {
  constructor(private readonly repository: { list(): Promise<ClientResult<readonly Incident[]>> }) {}

  async execute(): Promise<ClientResult<readonly Incident[]>> {
    return this.repository.list();
  }
}
