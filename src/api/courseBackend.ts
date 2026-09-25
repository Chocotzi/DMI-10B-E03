export type BackendHealth = Readonly<{
  ok: true;
  service: 'dmi-controlled-backend';
  contractVersion: 1;
}>;

const DEFAULT_URL = 'http://127.0.0.1:4310';
const SAFE_UNAVAILABLE_MESSAGE = 'El servicio no está disponible';

export async function getBackendHealth(
  baseUrl = process.env.EXPO_PUBLIC_COURSE_BACKEND_URL ?? DEFAULT_URL,
): Promise<BackendHealth> {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) {
    throw new Error(SAFE_UNAVAILABLE_MESSAGE);
  }
  const payload: unknown = await response.json();
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('ok' in payload) ||
    payload.ok !== true ||
    !('contractVersion' in payload) ||
    payload.contractVersion !== 1
  ) {
    throw new Error(SAFE_UNAVAILABLE_MESSAGE);
  }
  return payload as BackendHealth;
}
