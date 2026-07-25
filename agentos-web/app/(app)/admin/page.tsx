'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

function fmtDate(v: number | null) {
  return v ? new Date(v).toLocaleDateString('fa-IR') : '—';
}
function fmtToman(v: number) {
  return v ? v.toLocaleString('fa-IR') + ' تومان' : 'رایگان';
}

type Kpis = {
  totalTenants: number; activeTenants: number; suspendedTenants: number; totalUsers: number;
  byPlan: { plan_key: string; c: number }[]; activeTrials: number; agentActionsToday: number;
  pendingApprovals: number; totalContacts: number; totalDeals: number; totalInvoices: number;
  marketplaceModules: number; estimatedMRRToman: number; aiGatewayLive: boolean; aiGatewayProvider: string;
};
type TenantRow = {
  id: string; name: string; planKey: string; status: string; aiProvider: string; createdAt: number;
  userCount: number; contactCount: number; dealCount: number;
  trialActive: boolean; trialDaysLeft: number | null; lastActivityAt: number | null;
};
type Plan = {
  key: string; name: string; price_monthly_toman: number; price_yearly_toman: number;
  seats_limit: number | null; modules_limit: number | null; agent_actions_limit: number | null;
  is_active: number; features: Record<string, boolean>;
};
type MarketItem = {
  id: string; name: string; entity_label: string; publisherName: string; installs: number; enabled: number; created_at: number;
};
type AuditRow = { id: string; action: string; entity: string; actor_type: string; tenant_id: string; created_at: number };

const TABS = [
  { key: 'overview', label: 'نمای کلی' },
  { key: 'tenants', label: 'Tenantها' },
  { key: 'plans', label: 'پلن‌ها' },
  { key: 'marketplace', label: 'Marketplace' },
  { key: 'audit', label: 'Audit Log' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default function AdminPage() {
  const [tab, setTab] = useState<TabKey>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [market, setMarket] = useState<MarketItem[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  async function loadTab(t: TabKey) {
    setLoading(true);
    setError(null);
    try {
      if (t === 'overview') setKpis(await api('admin/kpis'));
      else if (t === 'tenants') setTenants(await api('admin/tenants'));
      else if (t === 'plans') setPlans(await api('admin/plans'));
      else if (t === 'marketplace') setMarket(await api('admin/marketplace'));
      else if (t === 'audit') setAudit(await api('admin/audit'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadTab(tab);
  }, [tab]);

  async function updateTenant(id: string, patch: { planKey?: string; status?: string }) {
    await api(`admin/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    loadTab('tenants');
  }
  async function updatePlan(key: string, patch: Record<string, any>) {
    await api(`admin/plans/${key}`, { method: 'PATCH', body: JSON.stringify(patch) });
    loadTab('plans');
  }
  async function toggleMarketItem(id: string, enabled: boolean) {
    await api(`admin/marketplace/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    loadTab('marketplace');
  }

  return (
    <div className="p-4 md:p-6 overflow-y-auto overflow-x-hidden flex flex-col gap-5">
      <h1 className="font-extrabold text-sm">Super Admin Dashboard</h1>

      <div className="flex gap-1.5 border-b border-[var(--border-soft)] overflow-x-auto whitespace-nowrap -mx-4 px-4 md:mx-0 md:px-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-xs font-semibold px-3.5 py-2.5 rounded-t-lg -mb-px border-b-2 shrink-0 ${
              tab === t.key ? 'border-[var(--primary)] text-[var(--primary)]' : 'border-transparent text-[var(--text-3)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="text-xs text-[var(--danger)] bg-[var(--danger-soft)] rounded-lg px-3 py-2">{error}</div>}
      {loading && <div className="text-xs text-[var(--text-3)]">در حال بارگذاری...</div>}

      {!loading && tab === 'overview' && kpis && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            ['Tenant فعال', `${kpis.activeTenants} / ${kpis.totalTenants}`],
            ['Tenant معلق', kpis.suspendedTenants],
            ['کل کاربران', kpis.totalUsers],
            ['دوره آزمایشی فعال', kpis.activeTrials],
            ['اکشن Agent (۲۴ساعت)', kpis.agentActionsToday],
            ['صف تایید', kpis.pendingApprovals],
            ['مخاطبین', kpis.totalContacts],
            ['معاملات', kpis.totalDeals],
            ['فاکتورها', kpis.totalInvoices],
            ['ماژول در Marketplace', kpis.marketplaceModules],
            ['MRR تخمینی', fmtToman(kpis.estimatedMRRToman)],
            ['AI Gateway', kpis.aiGatewayLive ? `زنده (${kpis.aiGatewayProvider})` : 'DEV_MOCK'],
          ].map(([label, value]) => (
            <div key={label as string} className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl p-4">
              <div className="text-[10.5px] text-[var(--text-3)] mb-1">{label}</div>
              <div className="text-lg font-extrabold">{value}</div>
            </div>
          ))}
          <div className="col-span-2 md:col-span-4 bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl p-4">
            <div className="text-[10.5px] text-[var(--text-3)] mb-2">توزیع پلن‌ها</div>
            <div className="flex gap-3 flex-wrap">
              {kpis.byPlan.map((p) => (
                <span key={p.plan_key} className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-full px-3 py-1">
                  {p.plan_key}: <b>{p.c}</b>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {!loading && tab === 'tenants' && (
        <div className="overflow-x-auto rounded-xl">
        <table className="w-full min-w-[720px] border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
          <thead>
            <tr className="text-[11px] text-[var(--text-3)]">
              {['نام', 'پلن', 'وضعیت', 'کاربران', 'مخاطب/معامله', 'آخرین فعالیت', ''].map((h) => (
                <th key={h} className="text-right px-3 py-2.5 border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id} className="text-[var(--text-2)]">
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <b className="text-[var(--text-1)]">{t.name}</b>
                  {t.trialActive && <span className="mr-2 text-[10px] text-[var(--primary)]">({t.trialDaysLeft} روز trial مونده)</span>}
                </td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <select
                    value={t.planKey}
                    onChange={(e) => updateTenant(t.id, { planKey: e.target.value })}
                    className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1 text-xs"
                  >
                    {plans.length ? plans.map((p) => <option key={p.key} value={p.key}>{p.name}</option>) : <option value={t.planKey}>{t.planKey}</option>}
                  </select>
                </td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${t.status === 'active' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--danger-soft)] text-[var(--danger)]'}`}>
                    {t.status}
                  </span>
                </td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{t.userCount}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{t.contactCount} / {t.dealCount}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{fmtDate(t.lastActivityAt)}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <button
                    onClick={() => updateTenant(t.id, { status: t.status === 'active' ? 'suspended' : 'active' })}
                    className="text-xs border border-[var(--border)] rounded-md px-2.5 py-1"
                  >
                    {t.status === 'active' ? 'تعلیق' : 'فعال‌سازی'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {!loading && tab === 'plans' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {plans.map((p) => (
            <div key={p.key} className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <b>{p.name}</b>
                <label className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-3)]">
                  <input
                    type="checkbox"
                    checked={!!p.is_active}
                    onChange={(e) => updatePlan(p.key, { isActive: e.target.checked })}
                  />
                  فعال
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <label className="flex flex-col gap-1">
                  قیمت ماهانه (تومان)
                  <input
                    type="number"
                    defaultValue={p.price_monthly_toman}
                    onBlur={(e) => updatePlan(p.key, { priceMonthlyToman: Number(e.target.value) })}
                    className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  قیمت سالانه (تومان)
                  <input
                    type="number"
                    defaultValue={p.price_yearly_toman}
                    onBlur={(e) => updatePlan(p.key, { priceYearlyToman: Number(e.target.value) })}
                    className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  سقف کاربر (خالی=نامحدود)
                  <input
                    type="number"
                    defaultValue={p.seats_limit ?? ''}
                    onBlur={(e) => updatePlan(p.key, { seatsLimit: e.target.value === '' ? null : Number(e.target.value) })}
                    className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  سقف ماژول (خالی=نامحدود)
                  <input
                    type="number"
                    defaultValue={p.modules_limit ?? ''}
                    onBlur={(e) => updatePlan(p.key, { modulesLimit: e.target.value === '' ? null : Number(e.target.value) })}
                    className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1.5"
                  />
                </label>
              </div>
              <div className="text-[10px] text-[var(--text-3)] mt-2">
                فیلدها با خروج فوکوس (blur) ذخیره می‌شن.
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && tab === 'marketplace' && (
        <div className="overflow-x-auto rounded-xl">
        <table className="w-full min-w-[560px] border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
          <thead>
            <tr className="text-[11px] text-[var(--text-3)]">
              {['نام ماژول', 'منتشرکننده', 'نصب', 'وضعیت', ''].map((h) => (
                <th key={h} className="text-right px-3 py-2.5 border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {market.map((m) => (
              <tr key={m.id} className="text-[var(--text-2)]">
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]"><b className="text-[var(--text-1)]">{m.name}</b></td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{m.publisherName}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{m.installs}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${m.enabled ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--danger-soft)] text-[var(--danger)]'}`}>
                    {m.enabled ? 'فعال' : 'مخفی'}
                  </span>
                </td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <button onClick={() => toggleMarketItem(m.id, !m.enabled)} className="text-xs border border-[var(--border)] rounded-md px-2.5 py-1">
                    {m.enabled ? 'مخفی‌کردن' : 'فعال‌سازی'}
                  </button>
                </td>
              </tr>
            ))}
            {market.length === 0 && (
              <tr><td colSpan={5} className="text-center text-[var(--text-3)] py-6">هیچ ماژولی منتشر نشده</td></tr>
            )}
          </tbody>
        </table>
        </div>
      )}

      {!loading && tab === 'audit' && (
        <div className="overflow-x-auto rounded-xl">
        <table className="w-full min-w-[640px] border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
          <thead>
            <tr className="text-[11px] text-[var(--text-3)]">
              {['اکشن', 'موجودیت', 'نوع فاعل', 'Tenant', 'زمان'].map((h) => (
                <th key={h} className="text-right px-3 py-2.5 border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id} className="text-[var(--text-2)] text-xs">
                <td className="px-3 py-2 border-b border-[var(--border-soft)]"><b className="text-[var(--text-1)]">{a.action}</b></td>
                <td className="px-3 py-2 border-b border-[var(--border-soft)]" dir="ltr" style={{ textAlign: 'left' }}>{a.entity || '—'}</td>
                <td className="px-3 py-2 border-b border-[var(--border-soft)]">{a.actor_type}</td>
                <td className="px-3 py-2 border-b border-[var(--border-soft)]" dir="ltr" style={{ textAlign: 'left' }}>{a.tenant_id}</td>
                <td className="px-3 py-2 border-b border-[var(--border-soft)]">{fmtDate(a.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
