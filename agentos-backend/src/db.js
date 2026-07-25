// db.js — SQL database layer. Two backends behind one async API:
//   - SQLite (node:sqlite, zero external dependency) — the default, used for
//     local dev and single-instance deploys.
//   - PostgreSQL (via `pg`) — used when DATABASE_URL is set. Needed once you
//     run more than one backend instance (SQLite is a single local file).
// Every call site in the rest of the app uses the same four async methods
// (db.get/db.all/db.run/db.exec) with `?` placeholders regardless of which
// backend is active, so switching backends never touches call sites —
// only this file knows the difference.
//
// Row-Level Security: agentos-deploy/schema-postgres.sql also defines RLS
// policies as a documented, NOT-YET-WIRED follow-up. Enabling those policies
// requires the app to run each request's queries on a single dedicated
// connection with `SET LOCAL app.current_tenant_id` set before any query —
// a real behavior change (the login-by-email lookup, for one, is
// necessarily cross-tenant before a tenant is known) that needs its own
// dedicated, tested pass. Today's tenant isolation is still enforced only in
// the application layer (every query filters by tenant_id explicitly) —
// exactly as it was under SQLite. This file only creates the plain tables.

const path = require('node:path');
const crypto = require('node:crypto');

function uid() {
  return crypto.randomBytes(9).toString('base64url');
}

function now() {
  return Date.now();
}

const usePostgres = !!process.env.DATABASE_URL;

let db;
let ready;

if (usePostgres) {
  const { Pool, types } = require('pg');
  // BIGINT (OID 20) comes back from `pg` as a string by default, since it
  // can exceed Number.MAX_SAFE_INTEGER — but every BIGINT column here is an
  // epoch-millisecond timestamp (Date.now()) or a Toman amount, always well
  // within safe-integer range. node:sqlite returns its INTEGER columns as
  // plain JS numbers, and call sites/the frontend (new Date(row.created_at),
  // numeric sorting, ...) assume a number — so parse BIGINT the same way
  // here to keep the two backends behaviorally identical.
  types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Translates the SQLite-style `?` positional placeholders used everywhere
  // in this codebase into PostgreSQL's `$1, $2, ...` — so call sites never
  // need backend-specific SQL strings.
  function pgSql(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  db = {
    async get(sql, params = []) {
      const { rows } = await pool.query(pgSql(sql), params);
      return rows[0];
    },
    async all(sql, params = []) {
      const { rows } = await pool.query(pgSql(sql), params);
      return rows;
    },
    async run(sql, params = []) {
      const res = await pool.query(pgSql(sql), params);
      return { changes: res.rowCount };
    },
    async exec(sql) {
      await pool.query(sql);
    },
  };

  ready = initSchemaPostgres(db);
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.AGENTOS_DB_PATH || path.join(__dirname, '..', 'data', 'agentos.sqlite');
  require('node:fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const raw = new DatabaseSync(DB_PATH);
  raw.exec('PRAGMA foreign_keys = ON;');

  db = {
    async get(sql, params = []) {
      return raw.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      const info = raw.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
    async exec(sql) {
      raw.exec(sql);
    },
  };

  ready = initSchemaSqlite(db);
}

async function initSchemaSqlite(db) {
  await db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- owner | member
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- Plan catalogue, managed from the Super Admin Dashboard. Seeded on first boot.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE, -- free | pro | business
  name TEXT NOT NULL,
  price_monthly REAL NOT NULL DEFAULT 0,
  price_yearly REAL NOT NULL DEFAULT 0,
  seats_limit INTEGER,          -- NULL = unlimited
  agent_actions_limit INTEGER,  -- NULL = unlimited, per month
  modules_limit INTEGER,        -- NULL = unlimited
  marketplace_access INTEGER NOT NULL DEFAULT 1, -- 0/1
  support_level TEXT NOT NULL DEFAULT 'community', -- community | priority | dedicated
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  contact_name TEXT,
  amount REAL,
  stage TEXT NOT NULL DEFAULT 'سرنخ',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deals_tenant ON deals(tenant_id);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  deal_title TEXT,
  amount REAL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);

CREATE TABLE IF NOT EXISTS custom_modules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  entity_label TEXT,
  fields_json TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modules_tenant ON custom_modules(tenant_id);

CREATE TABLE IF NOT EXISTS module_records (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES custom_modules(id),
  tenant_id TEXT NOT NULL,
  values_json TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_module ON module_records(module_id);
CREATE INDEX IF NOT EXISTS idx_records_tenant ON module_records(tenant_id);

-- Marketplace is intentionally NOT tenant-scoped for reads: it is the shared
-- catalogue. Only the schema (fields_json) is ever stored here — never
-- tenant business data — to preserve multi-tenant isolation (see blueprint §25/§34).
CREATE TABLE IF NOT EXISTS marketplace_modules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_label TEXT,
  fields_json TEXT NOT NULL,
  published_by_tenant TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, -- Super Admin can hide/unpublish a listing
  created_at INTEGER NOT NULL
);

-- audit_logs and pending_actions were replaced by the events table below (phase 1 —
-- docs/phase1-event-schema-agent-roles.md). No longer created for fresh
-- installs; on databases that still have them from before this migration,
-- run scripts/backfill-audit-to-events.js to migrate + drop them.

-- Team tasks: reminders, follow-ups, and delegation between personnel of the same tenant.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  assignee_id TEXT,        -- users.id within same tenant
  created_by TEXT NOT NULL,
  related_entity TEXT,     -- e.g. "deal:xxx", "contact:xxx"
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open', -- open | done | cancelled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);

-- Real billing transactions (Zarinpal). Separate from the CRM's own
-- invoices table on purpose — these are AgentOS's own subscription
-- revenue, not a tenant's business invoices to their customers.
CREATE TABLE IF NOT EXISTS subscription_payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  billing_cycle TEXT NOT NULL, -- monthly | yearly
  amount_toman INTEGER NOT NULL,
  authority TEXT NOT NULL UNIQUE, -- Zarinpal's payment session id
  ref_id TEXT,                    -- Zarinpal's transaction reference, set after verified payment
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON subscription_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_authority ON subscription_payments(authority);

-- Phase 1: unified write log, replacing audit_logs + pending_actions
-- (docs/phase1-event-schema-agent-roles.md). Every mutation and audit-trail
-- entry goes here now — see actions.js (dispatch/resolveEvent) and
-- agent.js's audit().
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'contact.created', 'deal.stage_changed', ...
  actor_type TEXT NOT NULL,    -- 'user' | 'agent' | 'system'
  actor_id TEXT,               -- users.id — the human responsible, even when actor_role='agent'
  actor_role TEXT NOT NULL,    -- 'owner' | 'admin' | 'member' | 'agent'
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied', -- 'applied' | 'pending_approval' | 'rejected'
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
`);

  // --- safe migrations for columns added after the tables already existed ---
  async function safeAlter(sql) {
    try { await db.exec(sql); } catch (e) { /* column already exists — fine */ }
  }
  await safeAlter(`ALTER TABLE tenants ADD COLUMN plan_key TEXT NOT NULL DEFAULT 'free'`);
  await safeAlter(`ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); // active | suspended
  await safeAlter(`ALTER TABLE tenants ADD COLUMN trial_start INTEGER`);
  await safeAlter(`ALTER TABLE tenants ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'anthropic'`);
  await safeAlter(`ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0`);
  await safeAlter(`ALTER TABLE users ADD COLUMN agent_name TEXT NOT NULL DEFAULT 'Agent'`);
  await safeAlter(`ALTER TABLE users ADD COLUMN agent_persona TEXT NOT NULL DEFAULT ''`);
  await safeAlter(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); // active | disabled (for removed personnel)
  await safeAlter(`ALTER TABLE plans ADD COLUMN features_json TEXT NOT NULL DEFAULT '{}'`);
  await safeAlter(`ALTER TABLE plans ADD COLUMN price_monthly_toman REAL NOT NULL DEFAULT 0`);
  await safeAlter(`ALTER TABLE plans ADD COLUMN price_yearly_toman REAL NOT NULL DEFAULT 0`);

  await seedPlans(db);
}

// PostgreSQL DDL — kept in sync by hand with the SQLite DDL above and with
// agentos-deploy/schema-postgres.sql (which additionally documents the
// not-yet-wired RLS policies). Uses IF NOT EXISTS throughout so it's safe to
// run on every boot, matching the SQLite path's behavior.
async function initSchemaPostgres(db) {
  await db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  plan_key TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  trial_start BIGINT,
  ai_provider TEXT NOT NULL DEFAULT 'anthropic',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
  agent_name TEXT NOT NULL DEFAULT 'Agent',
  agent_persona TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS plans (
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
  features_json TEXT NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);

CREATE TABLE IF NOT EXISTS deals (
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
CREATE INDEX IF NOT EXISTS idx_deals_tenant ON deals(tenant_id);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_title TEXT,
  amount REAL,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);

CREATE TABLE IF NOT EXISTS custom_modules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_label TEXT,
  fields_json TEXT NOT NULL,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modules_tenant ON custom_modules(tenant_id);

CREATE TABLE IF NOT EXISTS module_records (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES custom_modules(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  values_json TEXT NOT NULL,
  created_by TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_module ON module_records(module_id);
CREATE INDEX IF NOT EXISTS idx_records_tenant ON module_records(tenant_id);

CREATE TABLE IF NOT EXISTS marketplace_modules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_label TEXT,
  fields_json TEXT NOT NULL,
  published_by_tenant TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  amount_toman BIGINT NOT NULL,
  authority TEXT NOT NULL UNIQUE,
  ref_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  paid_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON subscription_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_authority ON subscription_payments(authority);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
`);

  await seedPlans(db);
}

// Pricing psychology: Free entry removes signup friction; Starter is the
// low-commitment step-up; Pro is anchored as "most popular" via feature
// generosity; Enterprise sits at a high anchor (up to 99,000,000 Toman/year)
// which makes Pro look like the obviously reasonable choice (decoy effect).
// Annual price is ~17% cheaper than monthly*12 to reward yearly commitment.
async function seedPlans(db) {
  const { c } = await db.get('SELECT COUNT(*) c FROM plans');
  if (Number(c) !== 0) return;
  const t = now();
  const insert = (id, key, name, pm, py, pmt, pyt, seats, actions, modules, marketplace, support, features) =>
    db.run(
      `INSERT INTO plans
        (id, key, name, price_monthly, price_yearly, price_monthly_toman, price_yearly_toman,
         seats_limit, agent_actions_limit, modules_limit, marketplace_access, support_level, features_json, is_active, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, key, name, pm, py, pmt, pyt, seats, actions, modules, marketplace, support, features, 1, t]
    );
  await insert(uid(), 'free', 'رایگان', 0, 0, 0, 0,
    1, 50, 1, 0, 'community',
    JSON.stringify({ team: false, voice: false, reports: false, marketplacePublish: false, customAgentPersona: false }));
  await insert(uid(), 'starter', 'استارتاپی', 33, 330, 990000, 9900000,
    5, 500, 3, 1, 'email',
    JSON.stringify({ team: true, voice: false, reports: true, marketplacePublish: false, customAgentPersona: true }));
  await insert(uid(), 'pro', 'حرفه‌ای', 99, 996, 2990000, 29900000,
    20, null, null, 1, 'priority',
    JSON.stringify({ team: true, voice: true, reports: true, marketplacePublish: true, customAgentPersona: true }));
  await insert(uid(), 'enterprise', 'سازمانی', 330, 3300, 9900000, 99000000,
    null, null, null, 1, 'dedicated',
    JSON.stringify({ team: true, voice: true, reports: true, marketplacePublish: true, customAgentPersona: true, sso: true, whiteLabel: true, dedicatedSLA: true }));
}

module.exports = { db, uid, now, ready };
