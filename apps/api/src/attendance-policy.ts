// PostgreSQL's attendance trigger is the final guard for tablet and QR writes.
export function isCompletedShiftError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; message?: string };
  return value.code === 'P0001' && value.message === 'SHIFT_ALREADY_COMPLETED';
}
