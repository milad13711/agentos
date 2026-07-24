// db.js — real SQL database layer (SQLite via Node's built-in node:sqlite).
// Swappable: everything here is plain SQL, so moving to Postgres later means
// changing this file only (see README "مسیر مهاجرت به Postgres").

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_PATH = process.env.AGENTOS_DB_PATH || path.join(__dirname, '..', 'data', 'agentos.sqlite');
require('node:fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_type TEXT NOT NULL, -- user | agent
  actor_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id);

-- Human-in-the-loop approval queue for sensitive Agent actions
-- (issue_invoice, delete_deal, delete_contact, build_module, publish_module, install_module).
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  domain TEXT NOT NULL,
  params_json TEXT NOT NULL,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
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

CREATE INDEX IF NOT EXISTS idx_pending_tenant ON pending_actions(tenant_id);
`);

// --- safe migrations for columns added after the tables already existed ---
function safeAlter(sql) {
  try { db.exec(sql); } catch (e) { /* column already exists — fine */ }
}
safeAlter(`ALTER TABLE tenants ADD COLUMN plan_key TEXT NOT NULL DEFAULT 'free'`);
safeAlter(`ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); // active | suspended
safeAlter(`ALTER TABLE tenants ADD COLUMN trial_start INTEGER`);
safeAlter(`ALTER TABLE tenants ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'anthropic'`);
safeAlter(`ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE users ADD COLUMN agent_name TEXT NOT NULL DEFAULT 'Agent'`);
safeAlter(`ALTER TABLE users ADD COLUMN agent_persona TEXT NOT NULL DEFAULT ''`);
safeAlter(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); // active | disabled (for removed personnel)
safeAlter(`ALTER TABLE plans ADD COLUMN features_json TEXT NOT NULL DEFAULT '{}'`);
safeAlter(`ALTER TABLE plans ADD COLUMN price_monthly_toman REAL NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE plans ADD COLUMN price_yearly_toman REAL NOT NULL DEFAULT 0`);

// --- seed default plans on first boot ---
// Pricing psychology: Free entry removes signup friction; Starter is the
// low-commitment step-up; Pro is anchored as "most popular" via feature
// generosity; Enterprise sits at a high anchor (up to 99,000,000 Toman/year)
// which makes Pro look like the obviously reasonable choice (decoy effect).
// Annual price is ~17% cheaper than monthly*12 to reward yearly commitment.
const planCount = db.prepare('SELECT COUNT(*) c FROM plans').get().c;
if (planCount === 0) {
  const t = now();
  const insertPlan = db.prepare(`INSERT INTO plans
    (id, key, name, price_monthly, price_yearly, price_monthly_toman, price_yearly_toman,
     seats_limit, agent_actions_limit, modules_limit, marketplace_access, support_level, features_json, is_active, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertPlan.run(uid(), 'free', 'رایگان', 0, 0, 0, 0,
    1, 50, 1, 0, 'community',
    JSON.stringify({ team:false, voice:false, reports:false, marketplacePublish:false, customAgentPersona:false }), 1, t);
  insertPlan.run(uid(), 'starter', 'استارتاپی', 33, 330, 990000, 9900000,
    5, 500, 3, 1, 'email',
    JSON.stringify({ team:true, voice:false, reports:true, marketplacePublish:false, customAgentPersona:true }), 1, t);
  insertPlan.run(uid(), 'pro', 'حرفه‌ای', 99, 996, 2990000, 29900000,
    20, null, null, 1, 'priority',
    JSON.stringify({ team:true, voice:true, reports:true, marketplacePublish:true, customAgentPersona:true }), 1, t);
  insertPlan.run(uid(), 'enterprise', 'سازمانی', 330, 3300, 9900000, 99000000,
    null, null, null, 1, 'dedicated',
    JSON.stringify({ team:true, voice:true, reports:true, marketplacePublish:true, customAgentPersona:true, sso:true, whiteLabel:true, dedicatedSLA:true }), 1, t);
}

function uid() {
  return crypto.randomBytes(9).toString('base64url');
}

function now() {
  return Date.now();
}

module.exports = { db, uid, now };
