import type { IncidentCategory } from '../contracts';
import type { ClientResult } from '../domain/IncidentRepository';

export class CreateIncidentUseCase {
  constructor(private readonly client: { create(input: { category: IncidentCategory; description: string; location: string; idempotencyKey: string }): Promise<ClientResult<unknown>> }) {}
  execute(input: { category: IncidentCategory; description: string; location: string; idempotencyKey: string }): Promise<ClientResult<unknown>> {
    return this.client.create(input);
  }
}
