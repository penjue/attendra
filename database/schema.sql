CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE attendance_action AS ENUM ('CHECK_IN','CHECK_OUT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE attendance_status AS ENUM ('ON_TIME','LATE','EARLY','UNSCHEDULED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  country_code char(2) NOT NULL CHECK (country_code IN ('GB','KE')),
  timezone text NOT NULL,
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  timezone text NOT NULL,
  address text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employees (
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

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  device_key_hash text NOT NULL,
  last_seen_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
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

CREATE TABLE IF NOT EXISTS attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  device_id uuid REFERENCES devices(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  shift_id uuid REFERENCES shifts(id),
  action attendance_action NOT NULL,
  status attendance_status NOT NULL DEFAULT 'UNSCHEDULED',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'TABLET'
);

ALTER TABLE attendance_events ALTER COLUMN device_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS pay_period_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL,
  include_overtime boolean NOT NULL DEFAULT true,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to > period_from),
  UNIQUE(company_id, period_from, period_to)
);

CREATE TABLE IF NOT EXISTS audit_log (
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

CREATE OR REPLACE FUNCTION prevent_unscheduled_tablet_attendance()
RETURNS trigger AS $$
BEGIN
  IF NEW.source = 'TABLET' AND NEW.shift_id IS NULL THEN
    RAISE EXCEPTION 'NO_SCHEDULED_SHIFT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_unscheduled_tablet_attendance ON attendance_events;
CREATE TRIGGER trg_prevent_unscheduled_tablet_attendance
BEFORE INSERT ON attendance_events
FOR EACH ROW EXECUTE FUNCTION prevent_unscheduled_tablet_attendance();

CREATE INDEX IF NOT EXISTS idx_attendance_company_time ON attendance_events(company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_time ON attendance_events(employee_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_employee_start ON shifts(employee_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_pay_period_approvals_company_period ON pay_period_approvals(company_id, period_from, period_to);
