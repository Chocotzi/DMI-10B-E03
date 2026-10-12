import { IncidentCategory, IncidentLocation, IncidentWork } from '../contracts';

export type Incident = {
  id: string;
  version: number;
  title: string;
  description: string;
  category: IncidentCategory;
  location: IncidentLocation;
  work: IncidentWork;
  createdAt?: string;
};
