import { Incident } from './Incident';

export type ClientResult<T> =
  | Readonly<{ kind: 'success'; value: T; unavailableIds?: readonly string[] }>
  | Readonly<{ kind: 'empty'; id: string; reason: 'null_payload' }>
  | Readonly<{ kind: 'error'; code: string; status?: number }>;

export interface IncidentRepository {
  getAll(): Promise<Incident[]>;
  getById(id: string): Promise<Incident | null>;
}
