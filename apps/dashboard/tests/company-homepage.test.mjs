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
  assert.match(index, /location\.pathname===\x27\/\x27/);
  assert.match(index, /has\(\x27resetToken\x27\)/);
});

test('physical login route forwards to workforce application', () => {
  assert.ok(read('public/login/index.html').includes('location.replace("/index.html"'));
});

test('production website does not contain staging backend URLs', () => {
  for (const path of ['index.html', 'public/company.html', 'public/login/index.html']) {
    assert.doesNotMatch(read(path), /attendra-api-staging\\.onrender\\.com/);
  }
});
test('login redirect preserves query string and fragment', () => {
  const login = read('public/login/index.html');
  assert.match(login, /location\\.search\\+location\\.hash/);
});
test('company homepage uses same-origin links and HTTPS-independent relative paths', () => {
  const html = read('public/company.html');
  assert.ok(!html.includes('href="http://'));
  assert.match(html, /href="mailto:admin@attendra\\.co\\.ke"/);
});
