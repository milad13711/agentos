-- ============================================================================
-- AgentOS — PostgreSQL schema (reference / future migration target)
-- ============================================================================
-- STATUS: NOT YET WIRED IN. The running app still uses SQLite (src/db.js).
-- This file is a faithful translation of that schema PLUS real Row-Level
-- Security, which SQLite cannot do natively (today's tenant isolation is
-- enforced only in the application layer — every query manually filters by
-- tenant_id). RLS makes the *database itself* refuse cross-tenant reads/
-- writes even if application code has a bug — a genuine defense-in-depth
-- upgrade, not just a swap of storage engines.
--
-- Migration is a real, non-trivial piece of work (see DEPLOY.md "PostgreSQL
-- migration checklist") because src/db.js and every `db.prepare(...).get/
-- all/run()` call in server.js and agent.js are synchronous (SQLite-style);
-- the `pg` driver is async, so every call site needs `await pool.query(...)`.
-- Do this as its own dedicated, tested change — not blindly applied.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid(), optional

-- Epoch-millisecond timestamps are kept as BIGINT to match the existing
-- application code (Date.now()) exactly — no behavior change needed there.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  plan_key TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',           -- active | suspended
  trial_start BIGINT,
  ai_provider TEXT NOT NULL DEFAULT 'anthropic',
  created_at BIGINT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',             -- owner | admin | member
  is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
  agent_name TEXT NOT NULL DEFAULT 'Agent',
  agent_persona TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',           -- active | disabled
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_monthly REAL NOT NULL DEFAULT 0,
  price_yearly REAL NOT NULL DEFAULT 0,
  price_monthly_toman REAL NOT NULL DEFAULT 0,
  price_yearly_toman REAL NOT NULL DEFAULT 0,
  seats_limit INTEGER,
  agent_actions_limit INTEGER,
  modules_limit INTEGER,
  marketplace_access BOOLEAN NOT NULL DEFAULT TRUE,
  support_level TEXT NOT NULL DEFAULT 'community',
  features_json JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at BIGINT NOT NULL
);
-- No RLS on plans — it's a platform-wide catalogue, not tenant data.

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);

CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  contact_name TEXT,
  amount REAL,
  stage TEXT NOT NULL DEFAULT 'سرنخ',
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_deals_tenant ON deals(tenant_id);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_title TEXT,
  amount REAL,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_invoices_tenant ON invoices(tenant_id);

CREATE TABLE custom_modules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_label TEXT,
  fields_json JSONB NOT NULL,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_modules_tenant ON custom_modules(tenant_id);

CREATE TABLE module_records (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES custom_modules(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  values_json JSONB NOT NULL,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_records_module ON module_records(module_id);
CREATE INDEX idx_records_tenant ON module_records(tenant_id);

-- Shared catalogue — deliberately NOT tenant-scoped for reads (see
-- blueprint §25/§34: only module schemas are shared, never tenant data).
CREATE TABLE marketplace_modules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_label TEXT,
  fields_json JSONB NOT NULL,
  published_by_tenant TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,     -- intentionally no FK: 'platform' is a valid sentinel value for admin actions
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  detail_json JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_audit_tenant ON audit_logs(tenant_id);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  domain TEXT NOT NULL,
  params_json JSONB NOT NULL,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX idx_pending_tenant ON pending_actions(tenant_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  assignee_id TEXT,
  created_by TEXT NOT NULL,
  related_entity TEXT,
  due_at BIGINT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);

-- ============================================================================
-- Row-Level Security — the actual point of migrating to Postgres.
-- Pattern: every tenant-scoped table checks tenant_id against a per-connection
-- session variable the app sets at the start of each request:
--   SET LOCAL app.current_tenant_id = '<tenantId from the verified token>';
-- If the app forgets a WHERE tenant_id = ? clause somewhere, the database
-- itself still blocks the cross-tenant row — that's the whole benefit.
-- ============================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','contacts','deals','invoices','custom_modules',
                            'module_records','pending_actions','tasks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.current_tenant_id'', true))',
      t
    );
  END LOOP;
END $$;

-- audit_logs uses the same session variable but allows the 'platform'
-- sentinel value (used for Super Admin actions not tied to one tenant).
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id = current_setting('app.current_tenant_id', true) OR tenant_id = 'platform');

-- tenants itself: a row is visible if its id matches the session tenant,
-- OR the session is flagged as super-admin (set app.is_super_admin = 'true').
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_or_admin ON tenants
  USING (id = current_setting('app.current_tenant_id', true)
         OR current_setting('app.is_super_admin', true) = 'true');

-- Seed plans (same data as db.js's JS seed block, kept in sync by hand).
INSERT INTO plans (id, key, name, price_monthly, price_yearly, price_monthly_toman, price_yearly_toman,
                    seats_limit, agent_actions_limit, modules_limit, marketplace_access, support_level,
                    features_json, is_active, updated_at)
VALUES
  (gen_random_uuid()::text, 'free', 'رایگان', 0, 0, 0, 0, 1, 50, 1, FALSE, 'community',
   '{"team":false,"voice":false,"reports":false,"marketplacePublish":false,"customAgentPersona":false}', TRUE, extract(epoch from now())*1000),
  (gen_random_uuid()::text, 'starter', 'استارتاپی', 33, 330, 990000, 9900000, 5, 500, 3, TRUE, 'email',
   '{"team":true,"voice":false,"reports":true,"marketplacePublish":false,"customAgentPersona":true}', TRUE, extract(epoch from now())*1000),
  (gen_random_uuid()::text, 'pro', 'حرفه‌ای', 99, 996, 2990000, 29900000, 20, NULL, NULL, TRUE, 'priority',
   '{"team":true,"voice":true,"reports":true,"marketplacePublish":true,"customAgentPersona":true}', TRUE, extract(epoch from now())*1000),
  (gen_random_uuid()::text, 'enterprise', 'سازمانی', 330, 3300, 9900000, 99000000, NULL, NULL, NULL, TRUE, 'dedicated',
   '{"team":true,"voice":true,"reports":true,"marketplacePublish":true,"customAgentPersona":true,"sso":true,"whiteLabel":true,"dedicatedSLA":true}', TRUE, extract(epoch from now())*1000);
