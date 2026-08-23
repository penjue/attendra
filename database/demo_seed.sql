-- Demo data for Attendra v0.1 only. Do not use these credentials in production.

INSERT INTO companies (id, name, country_code, timezone, currency)
VALUES ('11111111-1111-4111-8111-111111111111', 'Attendra Demo Ltd', 'GB', 'Europe/London', 'GBP')
ON CONFLICT (id) DO NOTHING;

INSERT INTO branches (id, company_id, name, timezone, address)
VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'London Demo Branch', 'Europe/London', 'Demo address')
ON CONFLICT (id) DO NOTHING;

INSERT INTO devices (id, company_id, branch_id, name, device_key_hash)
VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'Demo Wall Tablet', crypt('demo-device-key', gen_salt('bf')))
ON CONFLICT (id) DO NOTHING;

INSERT INTO employees (id, company_id, employee_number, first_name, last_name, pin_hash, hourly_worker)
VALUES ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '1042', 'Demo', 'Employee', crypt('1234', gen_salt('bf')), true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO shifts (id, company_id, branch_id, employee_id, starts_at, ends_at, break_minutes)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444444',
  date_trunc('day', now()) + interval '9 hours',
  date_trunc('day', now()) + interval '17 hours',
  30
)
ON CONFLICT (id) DO NOTHING;
