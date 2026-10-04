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

CREATE TABLE IF NOT EXISTS company_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('OWNER','ADMIN','MANAGER')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS admin_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES company_admins(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_password_reset_tokens_admin ON admin_password_reset_tokens(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_password_reset_tokens_expiry ON admin_password_reset_tokens(expires_at) WHERE used_at IS NULL;

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

CREATE TABLE IF NOT EXISTS device_activation_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_activation_tokens_device ON device_activation_tokens(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_activation_tokens_expiry ON device_activation_tokens(expires_at) WHERE used_at IS NULL;

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
  source text NOT NULL DEFAULT 'TABLET',
  client_event_id uuid
);

ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS client_event_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_events_device_client_event_uidx ON attendance_events(device_id, client_event_id) WHERE client_event_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS company_alert_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  late_after_minutes integer NOT NULL DEFAULT 5 CHECK (late_after_minutes BETWEEN 0 AND 180),
  missed_shift_after_minutes integer NOT NULL DEFAULT 10 CHECK (missed_shift_after_minutes BETWEEN 1 AND 180),
  missing_checkout_after_minutes integer NOT NULL DEFAULT 15 CHECK (missing_checkout_after_minutes BETWEEN 1 AND 240),
  tablet_offline_after_minutes integer NOT NULL DEFAULT 3 CHECK (tablet_offline_after_minutes BETWEEN 1 AND 60),
  notify_high_priority boolean NOT NULL DEFAULT true,
  notify_medium_priority boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_admins_email_ci ON company_admins(lower(email));
CREATE INDEX IF NOT EXISTS idx_company_admins_company ON company_admins(company_id, active);
CREATE INDEX IF NOT EXISTS idx_attendance_company_time ON attendance_events(company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_time ON attendance_events(employee_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_employee_start ON shifts(employee_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_pay_period_approvals_company_period ON pay_period_approvals(company_id, period_from, period_to);

CREATE TABLE IF NOT EXISTS employee_sessions (
 token_hash text PRIMARY KEY,
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 credential_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_sessions_expiry ON employee_sessions(expires_at);

CREATE OR REPLACE FUNCTION revoke_employee_sessions() RETURNS trigger AS $$
BEGIN
 IF NEW.pin_hash IS DISTINCT FROM OLD.pin_hash OR NOT NEW.active THEN
  DELETE FROM employee_sessions WHERE employee_id=NEW.id;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS employee_session_revocation ON employees;
CREATE TRIGGER employee_session_revocation AFTER UPDATE OF pin_hash, active ON employees
FOR EACH ROW EXECUTE FUNCTION revoke_employee_sessions();

-- Short-lived tablet QR challenges. A display can be scanned by multiple workers.
CREATE TABLE IF NOT EXISTS attendance_qr_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 token_hash text NOT NULL UNIQUE,
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
 device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 device_key_hash text NOT NULL,
 action attendance_action NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_qr_expiry ON attendance_qr_challenges(expires_at);
CREATE TABLE IF NOT EXISTS attendance_qr_claims (
 challenge_id uuid NOT NULL REFERENCES attendance_qr_challenges(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 event_id uuid NOT NULL REFERENCES attendance_events(id) ON DELETE CASCADE,
 PRIMARY KEY(challenge_id,employee_id)
);

-- Checkout is final for a scheduled shift across both employee attendance methods.
CREATE OR REPLACE FUNCTION prevent_completed_shift_check_in() RETURNS trigger AS $$
BEGIN
 IF NEW.shift_id IS NOT NULL AND NEW.source IN ('TABLET','EMPLOYEE_QR') THEN
  -- Serialize check-in with checkout, including submissions from different tablets.
  PERFORM id FROM shifts WHERE id=NEW.shift_id FOR UPDATE;
  IF NEW.action='CHECK_IN' AND EXISTS (
   SELECT 1 FROM attendance_events
   WHERE company_id=NEW.company_id AND employee_id=NEW.employee_id
     AND shift_id=NEW.shift_id AND action='CHECK_OUT'
  ) THEN
   RAISE EXCEPTION 'SHIFT_ALREADY_COMPLETED' USING ERRCODE='P0001';
  END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_prevent_completed_shift_check_in ON attendance_events;
CREATE TRIGGER trg_prevent_completed_shift_check_in BEFORE INSERT ON attendance_events
FOR EACH ROW EXECUTE FUNCTION prevent_completed_shift_check_in();

-- Repeating schedules, temporary availability and published employee notices.
CREATE TABLE IF NOT EXISTS employee_schedule_profiles (
 employee_id uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 job_role text NOT NULL DEFAULT '',
 max_weekly_hours numeric NOT NULL DEFAULT 40 CHECK (max_weekly_hours>0 AND max_weekly_hours<=168),
 allowed_branch_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS shift_patterns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
 name text NOT NULL,
 weekdays integer[] NOT NULL,
 start_time time NOT NULL,
 end_time time NOT NULL,
 break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes>=0),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS employee_unavailability (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 category text NOT NULL CHECK (category IN ('ABSENCE','INJURY','LEAVE','DAY_OFF')),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS idx_unavailability_employee_time ON employee_unavailability(company_id,employee_id,starts_at,ends_at) WHERE active=true;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT true;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS pattern_id uuid REFERENCES shift_patterns(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_pattern_occurrence ON shifts(pattern_id,starts_at) WHERE pattern_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS schedule_notices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 message text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedule_notices_employee ON schedule_notices(company_id,employee_id,created_at DESC);

-- These checks protect existing single-shift routes as well as bulk scheduling.
CREATE OR REPLACE FUNCTION validate_shift_assignment() RETURNS trigger AS $$
DECLARE profile employee_schedule_profiles%ROWTYPE;
 company_zone text; week_start timestamptz; week_end timestamptz; scheduled_hours numeric; hours_limit numeric;
BEGIN
 PERFORM id FROM employees WHERE id=NEW.employee_id AND company_id=NEW.company_id AND active=true FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
 PERFORM id FROM branches WHERE id=NEW.branch_id AND company_id=NEW.company_id AND active=true;
 IF NOT FOUND THEN RAISE EXCEPTION 'BRANCH_NOT_FOUND' USING ERRCODE='P0001'; END IF;
 IF TG_OP='UPDATE' AND (NEW.employee_id,NEW.branch_id,NEW.starts_at,NEW.ends_at,NEW.break_minutes) IS DISTINCT FROM (OLD.employee_id,OLD.branch_id,OLD.starts_at,OLD.ends_at,OLD.break_minutes)
 AND EXISTS(SELECT 1 FROM attendance_events WHERE shift_id=NEW.id) THEN
  RAISE EXCEPTION 'SHIFT_HAS_ATTENDANCE' USING ERRCODE='P0001';
 END IF;
 IF NEW.break_minutes>=extract(epoch FROM(NEW.ends_at-NEW.starts_at))/60 THEN RAISE EXCEPTION 'BREAK_EXCEEDS_SHIFT' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM shifts WHERE company_id=NEW.company_id AND employee_id=NEW.employee_id AND id<>NEW.id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at) THEN
  RAISE EXCEPTION 'SHIFT_OVERLAP' USING ERRCODE='P0001';
 END IF;
 IF NEW.published AND EXISTS(SELECT 1 FROM employee_unavailability WHERE company_id=NEW.company_id AND employee_id=NEW.employee_id AND active=true AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at) THEN
  RAISE EXCEPTION 'EMPLOYEE_UNAVAILABLE' USING ERRCODE='P0001';
 END IF;
 SELECT * INTO profile FROM employee_schedule_profiles WHERE employee_id=NEW.employee_id AND company_id=NEW.company_id;
 IF FOUND AND cardinality(profile.allowed_branch_ids)>0 AND NOT(NEW.branch_id=ANY(profile.allowed_branch_ids)) THEN
  RAISE EXCEPTION 'BRANCH_NOT_ALLOWED' USING ERRCODE='P0001';
 END IF;
 SELECT timezone INTO company_zone FROM companies WHERE id=NEW.company_id;
 week_start:=date_trunc('week',NEW.starts_at AT TIME ZONE company_zone) AT TIME ZONE company_zone;
 week_end:=(date_trunc('week',NEW.starts_at AT TIME ZONE company_zone)+interval '7 days') AT TIME ZONE company_zone;
 hours_limit:=coalesce(profile.max_weekly_hours,40);
 SELECT coalesce(sum(extract(epoch FROM(ends_at-starts_at))/3600-break_minutes/60.0),0) INTO scheduled_hours
 FROM shifts WHERE company_id=NEW.company_id AND employee_id=NEW.employee_id AND id<>NEW.id AND starts_at>=week_start AND starts_at<week_end;
 IF scheduled_hours+extract(epoch FROM(NEW.ends_at-NEW.starts_at))/3600-NEW.break_minutes/60.0>hours_limit THEN
  RAISE EXCEPTION 'WEEKLY_HOURS_EXCEEDED' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_validate_shift_assignment ON shifts;
CREATE TRIGGER trg_validate_shift_assignment BEFORE INSERT OR UPDATE OF employee_id,branch_id,starts_at,ends_at,break_minutes,published ON shifts
FOR EACH ROW EXECUTE FUNCTION validate_shift_assignment();

CREATE OR REPLACE FUNCTION validate_employee_shift_attendance() RETURNS trigger AS $$
BEGIN
 IF NEW.source IN ('TABLET','EMPLOYEE_QR') AND NEW.shift_id IS NOT NULL THEN
  PERFORM id FROM shifts WHERE id=NEW.shift_id AND company_id=NEW.company_id AND employee_id=NEW.employee_id AND branch_id=NEW.branch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_ASSIGNMENT_CHANGED' USING ERRCODE='P0001'; END IF;
 END IF;
 IF NEW.source IN ('TABLET','EMPLOYEE_QR') AND NEW.shift_id IS NOT NULL AND NEW.action='CHECK_IN' THEN
  IF NOT EXISTS(SELECT 1 FROM shifts WHERE id=NEW.shift_id AND published=true) THEN RAISE EXCEPTION 'SHIFT_NOT_PUBLISHED' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM employee_unavailability u JOIN shifts s ON s.id=NEW.shift_id
   WHERE u.employee_id=NEW.employee_id AND u.company_id=NEW.company_id AND u.active=true AND u.starts_at<s.ends_at AND u.ends_at>s.starts_at) THEN
   RAISE EXCEPTION 'EMPLOYEE_UNAVAILABLE' USING ERRCODE='P0001';
  END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_validate_employee_shift_attendance ON attendance_events;
CREATE TRIGGER trg_validate_employee_shift_attendance BEFORE INSERT ON attendance_events
FOR EACH ROW EXECUTE FUNCTION validate_employee_shift_attendance();
