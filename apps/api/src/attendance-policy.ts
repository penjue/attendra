// PostgreSQL's attendance trigger is the final guard for tablet and QR writes.
export function isCompletedShiftError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; message?: string };
  return value.code === 'P0001' && value.message === 'SHIFT_ALREADY_COMPLETED';
}

export function attendancePolicyError(error:unknown):string|null {
 const e=error as {code?:string;message?:string}|null;
 return e?.code==='P0001'&&['SHIFT_ALREADY_COMPLETED','EMPLOYEE_UNAVAILABLE','SHIFT_NOT_PUBLISHED','SHIFT_ASSIGNMENT_CHANGED','NO_SCHEDULED_SHIFT'].includes(e.message||'')?e.message!:null;
}
