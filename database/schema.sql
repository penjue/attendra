CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  country_code char(2) NOT NULL CHECK (country_code IN ('GB','KE')),
  timezone text NOT NULL,
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  timezone text NOT NULL,
  address text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_number text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  pin_hash text NOT NULL,
  hourly_worker boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, employee_number)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  device_key_hash text NOT NULL,
  last_seen_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TYPE attendance_action AS ENUM ('CHECK_IN','CHECK_OUT');
CREATE TYPE attendance_status AS ENUM ('ON_TIME','LATE','EARLY','UNSCHEDULED');

CREATE TABLE attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  shift_id uuid REFERENCES shifts(id),
  action attendance_action NOT NULL,
  status attendance_status NOT NULL DEFAULT 'UNSCHEDULED',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'TABLET'
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attendance_company_time ON attendance_events(company_id, occurred_at DESC);
CREATE INDEX idx_attendance_employee_time ON attendance_events(employee_id, occurred_at DESC);
CREATE INDEX idx_shifts_employee_start ON shifts(employee_id, starts_at);
