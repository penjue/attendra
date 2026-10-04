import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eligibleCover,netShiftHours,validDateRange} from '../dist/scheduling-rules.js';
const candidate={employeeId:'worker',jobRole:'Barista',maxWeeklyHours:40,scheduledHours:32,unavailable:false,overlap:false,allowedBranches:['branch']};
test('cover eligibility rejects absence, overlap, wrong role, wrong branch and excessive hours',()=>{
 assert.equal(eligibleCover(candidate,'branch','barista',8),true);
 for(const change of [{unavailable:true},{overlap:true},{jobRole:'Cashier'},{allowedBranches:['other']},{scheduledHours:33}])assert.equal(eligibleCover({...candidate,...change},'branch','Barista',8),false);
 assert.equal(eligibleCover({...candidate,allowedBranches:[]},'other','',8),true);
});
test('net hours account for overnight shifts, DST and breaks',()=>{
 assert.equal(netShiftHours('2026-10-24T21:00:00Z','2026-10-25T06:00:00Z',60),8);
 assert.equal(netShiftHours('2026-10-04T21:00:00Z','2026-10-05T05:00:00Z',30),7.5);
});
test('bounded date ranges reject reversed, malformed and excessively wide requests',()=>{
 assert.equal(validDateRange('2026-10-01','2026-11-30'),true);
 for(const range of [['2026-10-05','2026-10-04'],['bad','2026-10-04'],['2026-10-01','2026-12-02']])assert.equal(validDateRange(...range),false);
});
