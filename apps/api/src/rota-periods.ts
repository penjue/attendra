/** Date-only UTC helpers; no server-local timezone conversion. */
export function nextRotaPeriod(start:string,cadence:'WEEKLY'|'MONTHLY'):string{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start))throw new Error('INVALID_DATE');
 const d=new Date(start+'T00:00:00.000Z');
 if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==start)throw new Error('INVALID_DATE');
 if(cadence==='WEEKLY')d.setUTCDate(d.getUTCDate()+7);
 else {if(d.getUTCDate()!==1)throw new Error('MONTHLY_PERIOD_MUST_START_ON_FIRST');d.setUTCMonth(d.getUTCMonth()+1)}
 return d.toISOString().slice(0,10);
}
export function rotaShiftDate(periodStart:string,cadence:'WEEKLY'|'MONTHLY',offset:number):string|null{
 if(!Number.isInteger(offset)||offset<0||offset>30)return null;
 const end=nextRotaPeriod(periodStart,cadence);
 const d=new Date(periodStart+'T00:00:00.000Z');
 d.setUTCDate(d.getUTCDate()+offset);
 const result=d.toISOString().slice(0,10);
 return result<end?result:null;
}
