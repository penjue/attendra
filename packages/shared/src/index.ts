export type CountryCode = 'GB' | 'KE';
export type AttendanceAction = 'CHECK_IN' | 'CHECK_OUT';
export type AttendanceStatus = 'ON_TIME' | 'LATE' | 'EARLY' | 'UNSCHEDULED';

export interface AttendanceEventInput {
  companyId: string;
  branchId: string;
  deviceId: string;
  employeeNumber: string;
  pin: string;
  action: AttendanceAction;
  occurredAt?: string;
}
