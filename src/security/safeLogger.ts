import { redactForTelemetry } from './redactForTelemetry';

export function logTelemetry(event: string, details: unknown): void {
  console.info(event, redactForTelemetry(details));
}
