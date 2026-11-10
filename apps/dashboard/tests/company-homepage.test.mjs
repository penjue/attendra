import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
test('public company page contains verified legal identity and contact', () => {
  const html = read('public/company.html');
  for (const value of ['ATTENDRA NEX SOLUTION LIMITED','PVT-RQ1K7RV9','14 October 2026','admin@attendra.co.ke','INFORMATION TECHNOLOGY SOLUTION FOR BUSINESSES AND ORGANISATIONS.']) {
    assert.ok(html.includes(value), 'Missing verified company information: ' + value);
  }
});
test('public homepage links to the workforce entrypoint', () => {
  assert.match(read('public/company.html'), /href="\/login\/"/);
});
test('root redirect preserves existing password reset links', () => {
  const index = read('index.html');
  assert.match(index, /location\.pathname==="\/"/);
  assert.match(index, /has\("resetToken"\)/);
});
test('Render config preserves login SPA fallback', () => {
  const config = read('../../render.yaml');
  assert.match(config, /source: \/login\s+destination: \/index\.html/);
});

test('physical login route forwards to workforce application', () => {
  assert.match(read('public/login/index.html'), /location\\.replace\\(\"\\/index\\.html\"/);
});
