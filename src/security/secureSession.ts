export type SecureSession = Readonly<{
  accessToken: string;
  actorId: string;
  expiresAt: number;
}>;

let activeSession: SecureSession | null = null;

// Keep the session only in memory; tokens are never written to logs or device storage.
export function setSecureSession(session: SecureSession): void {
  activeSession = { ...session };
}

export function getSecureSession(): SecureSession | null {
  return activeSession;
}

export function clearSecureSession(): void {
  activeSession = null;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return 'No fue posible completar la operación.';
  return 'Ocurrió un error inesperado.';
}
