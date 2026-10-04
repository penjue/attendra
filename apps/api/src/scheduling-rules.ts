export type Candidate = { employeeId:string; jobRole:string; maxWeeklyHours:number; scheduledHours:number; unavailable:boolean; overlap:boolean; allowedBranches:string[] };
export function eligibleCover(candidate:Candidate, branchId:string, requiredRole:string, shiftHours:number){
 return !candidate.unavailable&&!candidate.overlap&&(!requiredRole||candidate.jobRole.toLowerCase()===requiredRole.toLowerCase())&&(!candidate.allowedBranches.length||candidate.allowedBranches.includes(branchId))&&candidate.scheduledHours+shiftHours<=candidate.maxWeeklyHours;
}
export function validDateRange(from:string,to:string,maxDays=62){const start=Date.parse(from),end=Date.parse(to);return Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&(end-start)/86400000<maxDays;}
export function netShiftHours(startsAt:string|Date,endsAt:string|Date,breakMinutes:number){return Math.max(0,(new Date(endsAt).getTime()-new Date(startsAt).getTime())/3600000-breakMinutes/60);}
