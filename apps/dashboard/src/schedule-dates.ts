// Date keys use the company timezone; arithmetic on keys is independent of the device timezone.
export function dateKey(value:string|Date,zone:string){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));const get=(type:string)=>parts.find(p=>p.type===type)!.value;return `${get('year')}-${get('month')}-${get('day')}`;}
export function addDays(key:string,n:number){const date=new Date(`${key}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+n);return date.toISOString().slice(0,10);}
export function monday(key:string){return addDays(key,-((new Date(`${key}T12:00:00Z`).getUTCDay()+6)%7));}
export function labelDay(key:string,options:Intl.DateTimeFormatOptions={weekday:'short',day:'numeric',month:'short'}){return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined,{...options,timeZone:'UTC'});}
export function onDay(item:{startsAt:string;endsAt:string},key:string,zone:string){return dateKey(item.startsAt,zone)<=key&&dateKey(new Date(new Date(item.endsAt).getTime()-1),zone)>=key;}
export function shiftTime(item:{startsAt:string;endsAt:string},zone:string){const time=(v:string)=>new Date(v).toLocaleTimeString(undefined,{timeZone:zone,hour:'2-digit',minute:'2-digit'});return `${time(item.startsAt)} – ${time(item.endsAt)}${dateKey(item.startsAt,zone)!==dateKey(item.endsAt,zone)?' (+1 day)':''}`;}
