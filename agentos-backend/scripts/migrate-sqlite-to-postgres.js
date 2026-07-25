// One-off data migration: copies every row from an existing SQLite database
// file into a PostgreSQL database, for the PostgreSQL cutover described in
// agentos-deploy/DEPLOY.md ("PostgreSQL migration checklist"). Table shapes
// are identical between the two backends (see src/db.js) so this is a
// straight row-by-row copy, no transformation needed beyond letting the pg
// driver bind the same values.
//
// Usage:
//   AGENTOS_DB_PATH=/path/to/agentos.sqlite \
//   DATABASE_URL=postgres://user:pass@host:5432/agentos \
//   node scripts/migrate-sqlite-to-postgres.js
//
// Destructive by design: truncates the destination tables first, so it's
// safe to re-run (e.g. after fixing a data issue) without duplicate-key
// errors. Only ever point DATABASE_URL at the *new* database you're cutting
// over to — never at a database already serving live traffic.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Pool, types } = require('pg');

types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const sqlitePath = process.env.AGENTOS_DB_PATH || path.join(__dirname, '..', 'data', 'agentos.sqlite');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required (destination Postgres database).');
  process.exit(1);
}

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const pool = new Pool({ connectionString: databaseUrl });

// Order matters: children after the parents they reference (FK constraints).
const TABLES = [
  { name: 'tenants', columns: ['id', 'name', 'plan', 'plan_key', 'status', 'trial_start', 'ai_provider', 'created_at'] },
  { name: 'plans', columns: ['id', 'key', 'name', 'price_monthly', 'price_yearly', 'price_monthly_toman', 'price_yearly_toman', 'seats_limit', 'agent_actions_limit', 'modules_limit', 'marketplace_access', 'support_level', 'features_json', 'is_active', 'updated_at'] },
  { name: 'users', columns: ['id', 'tenant_id', 'name', 'email', 'password_hash', 'salt', 'role', 'is_super_admin', 'agent_name', 'agent_persona', 'status', 'telegram_chat_id', 'created_at'] },
  { name: 'contacts', columns: ['id', 'tenant_id', 'name', 'phone', 'company', 'created_by', 'created_at'] },
  { name: 'deals', columns: ['id', 'tenant_id', 'title', 'contact_name', 'amount', 'stage', 'created_by', 'created_at', 'updated_at'] },
  { name: 'invoices', columns: ['id', 'tenant_id', 'deal_title', 'amount', 'created_by', 'created_at'] },
  { name: 'custom_modules', columns: ['id', 'tenant_id', 'name', 'entity_label', 'fields_json', 'created_by', 'source_market_id', 'created_at'] },
  { name: 'module_records', columns: ['id', 'module_id', 'tenant_id', 'values_json', 'created_by', 'created_at'] },
  { name: 'module_automations', columns: ['id', 'tenant_id', 'module_id', 'trigger', 'action_type', 'config_json', 'enabled', 'created_by', 'created_at'] },
  { name: 'marketplace_modules', columns: ['id', 'name', 'entity_label', 'fields_json', 'published_by_tenant', 'installs', 'enabled', 'created_at'] },
  { name: 'tasks', columns: ['id', 'tenant_id', 'title', 'description', 'assignee_id', 'created_by', 'related_entity', 'due_at', 'status', 'reminder_sent_at', 'created_at', 'updated_at'] },
  { name: 'subscription_payments', columns: ['id', 'tenant_id', 'plan_key', 'billing_cycle', 'amount_toman', 'authority', 'ref_id', 'status', 'created_at', 'paid_at'] },
  { name: 'events', columns: ['id', 'tenant_id', 'type', 'actor_type', 'actor_id', 'actor_role', 'entity_type', 'entity_id', 'payload_json', 'status', 'created_at', 'resolved_at'] },
  { name: 'telegram_link_codes', columns: ['code', 'tenant_id', 'user_id', 'expires_at', 'created_at'] },
  { name: 'telegram_poll_state', columns: ['id', 'last_update_id'] },
];

function tableExistsInSqlite(name) {
  return !!sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

async function migrateTable({ name, columns }) {
  if (!tableExistsInSqlite(name)) {
    console.log(`skip ${name}: not present in source SQLite database`);
    return;
  }
  const rows = sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${name}`).all();
  await pool.query(`TRUNCATE TABLE ${name} CASCADE`);
  if (!rows.length) {
    console.log(`${name}: 0 rows`);
    return;
  }
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders})`;
  for (const row of rows) {
    const values = columns.map(c => row[c]);
    await pool.query(insertSql, values);
  }
  console.log(`${name}: ${rows.length} rows migrated`);
}

(async () => {
  try {
    for (const table of TABLES) {
      await migrateTable(table);
    }
    console.log('Migration complete.');
  } finally {
    sqlite.close();
    await pool.end();
  }
})().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
