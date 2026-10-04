import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../src/schedule-dates.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {dateKey,addDays,monday,onDay}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('date keys use company timezone across midnight and daylight saving',()=>{
 assert.equal(dateKey('2026-10-04T22:30:00Z','Africa/Nairobi'),'2026-10-05');
 assert.equal(dateKey('2026-10-24T23:30:00Z','Europe/London'),'2026-10-25');
 assert.equal(dateKey('2026-10-25T23:30:00Z','Europe/London'),'2026-10-25');
});
test('week navigation spans months and years independently of device timezone',()=>{
 assert.equal(monday('2026-10-04'),'2026-09-28');assert.equal(addDays('2026-12-28',6),'2027-01-03');assert.equal(addDays('2028-02-28',1),'2028-02-29');
});
test('overnight shifts appear on each occupied day, with an exclusive end boundary',()=>{
 const s={startsAt:'2026-10-04T20:00:00Z',endsAt:'2026-10-05T02:00:00Z'};
 assert.equal(onDay(s,'2026-10-04','Africa/Nairobi'),true);assert.equal(onDay(s,'2026-10-05','Africa/Nairobi'),true);assert.equal(onDay(s,'2026-10-06','Africa/Nairobi'),false);
 assert.equal(onDay({...s,endsAt:'2026-10-04T21:00:00Z'},'2026-10-05','Africa/Nairobi'),false);
});
