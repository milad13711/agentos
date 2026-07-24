// One-off migration (docs/phase1-event-schema-agent-roles.md, step 4):
// copies historical audit_logs rows into events with status='executed', so
// they show up in the same unified log without being confused with rows
// events itself wrote live (status='applied'). Idempotent — reuses the
// audit_logs row's own id as the events.id, so INSERT OR IGNORE makes a
// second run a no-op.
//
// Usage:
//   node scripts/backfill-audit-to-events.js            # backfill only
//   node scripts/backfill-audit-to-events.js --drop-legacy-tables
//     ^ ALSO drops audit_logs and pending_actions after backfilling.
//     Only pass this after you've verified the backfilled events look right
//     (e.g. compare row counts, spot-check a few entries) — see the
//     checklist in docs/phase1-event-schema-agent-roles.md before running
//     this against the production database.
const { db, uid, now } = require('../src/db');

function backfill() {
  const rows = db.prepare('SELECT * FROM audit_logs').all();
  const insert = db.prepare(`INSERT OR IGNORE INTO events
    (id, tenant_id, type, actor_type, actor_id, actor_role, entity_type, entity_id, payload_json, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  for (const row of rows) {
    const [entityType, entityId] = row.entity ? row.entity.split(':') : [null, null];
    const result = insert.run(
      row.id, row.tenant_id, row.action, row.actor_type, row.actor_id, row.actor_type,
      entityType || null, entityId || null, row.detail_json || '{}', 'executed', row.created_at
    );
    if (result.changes) inserted++;
  }
  console.log(`audit_logs rows: ${rows.length}, newly inserted into events: ${inserted}`);
}

function dropLegacyTables() {
  db.exec('DROP TABLE IF EXISTS audit_logs;');
  db.exec('DROP TABLE IF EXISTS pending_actions;');
  console.log('Dropped audit_logs and pending_actions.');
}

backfill();
if (process.argv.includes('--drop-legacy-tables')) dropLegacyTables();
