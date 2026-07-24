// roles.js — Phase 1 capability matrix (docs/phase1-event-schema-agent-roles.md).
// Mirrors the current SENSITIVE_ACTIONS set in agent.js: only the 'agent'
// role is restricted today. Expressed as event types instead of action
// names so it can be shared by both the REST and Agent dispatch paths.
const APPROVAL_REQUIRED = {
  agent: new Set([
    'invoice.issued', 'deal.deleted', 'contact.deleted',
    'module.created', 'module.deleted', 'marketplace.published', 'module.installed',
  ]),
};

function requiresApproval(role, type) {
  const set = APPROVAL_REQUIRED[role];
  return !!set && set.has(type);
}

module.exports = { requiresApproval };
