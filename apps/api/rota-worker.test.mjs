import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const url=process.env.SCHEDULING_TEST_DATABASE_URL;
const command=process.execPath;
const script=new URL('./dist/rota-worker.js',import.meta.url).pathname;
const base={...process.env,DATABASE_URL:url||'postgres://postgres:postgres@localhost:5432/attendra_test',ADMIN_TOKEN_SECRET:'test-only-worker-secret'};

test('scheduled worker refuses execution without explicit opt-in',()=>{
 const env={...base,ATTENDRA_ROTA_WORKER_ENABLED:'false',ATTENDRA_ROTA_WORKER_ENV:'staging'};
 const r=spawnSync(command,[script],{env,encoding:'utf8',timeout:10000});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/Rota worker disabled/);
});

test('scheduled worker refuses production execution even when enabled',()=>{
 const env={...base,ATTENDRA_ROTA_WORKER_ENABLED:'true',ATTENDRA_ROTA_WORKER_ENV:'production'};
 const r=spawnSync(command,[script],{env,encoding:'utf8',timeout:10000});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/staging-only/);
});

test('scheduled worker refuses to start without an admin token secret',()=>{
 const env={...base,ATTENDRA_ROTA_WORKER_ENABLED:'true',ATTENDRA_ROTA_WORKER_ENV:'staging',ADMIN_TOKEN_SECRET:''};
 const r=spawnSync(command,[script],{env,encoding:'utf8',timeout:10000});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/ADMIN_TOKEN_SECRET is required/);
});
