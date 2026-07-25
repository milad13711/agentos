'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

type Field = { key: string; label: string; type: string };
type ModuleT = { id: string; name: string; entity_label: string; fields: Field[]; created_at: number };
type RecordT = { id: string; values_json: string; created_at: number };
type Automation = {
  id: string;
  action_type: 'create_task' | 'webhook';
  config: { titleTemplate?: string; dueInDays?: number; url?: string };
  enabled: number;
};

const ACTION_LABELS: Record<string, string> = { create_task: 'ساخت وظیفه خودکار', webhook: 'ارسال Webhook' };

export default function ModulesPage() {
  const [modules, setModules] = useState<ModuleT[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ModuleT | null>(null);
  const [records, setRecords] = useState<RecordT[]>([]);
  const [newValues, setNewValues] = useState<Record<string, string>>({});
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [newAutomationType, setNewAutomationType] = useState<'create_task' | 'webhook'>('create_task');
  const [newAutomationTitle, setNewAutomationTitle] = useState('');
  const [newAutomationUrl, setNewAutomationUrl] = useState('');
  const [automationError, setAutomationError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const mods = await api('modules');
    setModules(mods);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function openModule(m: ModuleT) {
    setSelected(m);
    setNewValues({});
    setAutomationError(null);
    const [recs, autos] = await Promise.all([api(`modules/${m.id}/records`), api(`modules/${m.id}/automations`)]);
    setRecords(recs);
    setAutomations(autos);
  }

  async function addRecord() {
    if (!selected) return;
    await api(`modules/${selected.id}/records`, { method: 'POST', body: JSON.stringify({ values: newValues }) });
    const recs = await api(`modules/${selected.id}/records`);
    setRecords(recs);
    setNewValues({});
  }

  async function addAutomation() {
    if (!selected) return;
    setAutomationError(null);
    const config = newAutomationType === 'create_task' ? { titleTemplate: newAutomationTitle } : { url: newAutomationUrl };
    try {
      await api(`modules/${selected.id}/automations`, { method: 'POST', body: JSON.stringify({ actionType: newAutomationType, config }) });
      setAutomations(await api(`modules/${selected.id}/automations`));
      setNewAutomationTitle('');
      setNewAutomationUrl('');
    } catch (e: any) {
      setAutomationError(e.message);
    }
  }

  async function toggleAutomation(a: Automation) {
    if (!selected) return;
    await api(`modules/${selected.id}/automations/${a.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !a.enabled }) });
    setAutomations(await api(`modules/${selected.id}/automations`));
  }

  async function deleteAutomation(a: Automation) {
    if (!selected) return;
    await api(`modules/${selected.id}/automations/${a.id}`, { method: 'DELETE' });
    setAutomations(await api(`modules/${selected.id}/automations`));
  }

  if (loading) return <div className="p-4 md:p-6 text-sm text-[var(--text-3)]">در حال بارگذاری...</div>;

  return (
    <div className="p-4 md:p-6 overflow-y-auto overflow-x-hidden flex flex-col md:flex-row gap-5">
      <div className="w-full md:w-64 shrink-0">
        <h1 className="font-extrabold text-sm mb-3">ماژول‌های ساخته‌شده</h1>
        {modules.length === 0 && (
          <div className="text-xs text-[var(--text-3)] bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl p-4">
            هنوز ماژولی نساختی. توی چت به Agent بگو مثلاً «یه ماژول گارانتی بساز».
          </div>
        )}
        <div className="flex flex-col gap-2">
          {modules.map((m) => (
            <button
              key={m.id}
              onClick={() => openModule(m)}
              className={`text-right text-sm rounded-xl border px-3 py-2.5 ${
                selected?.id === m.id ? 'border-[var(--primary-dim)] bg-[var(--primary-soft)] text-[var(--primary)]' : 'border-[var(--border-soft)] bg-[var(--surface)] text-[var(--text-1)]'
              }`}
            >
              <div className="font-bold">{m.name}</div>
              <div className="text-[10.5px] text-[var(--text-3)] mt-0.5">{m.fields?.length ?? 0} فیلد</div>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div className="flex-1 min-w-0">
          <h2 className="font-extrabold text-sm mb-3">{selected.name} — رکوردها</h2>

          <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 mb-4">
            <h3 className="font-bold text-xs mb-2.5">افزودن رکورد جدید</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-3">
              {selected.fields.map((f) => (
                <div key={f.key}>
                  <label className="block text-[10.5px] text-[var(--text-3)] mb-1">{f.label}</label>
                  <input
                    type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                    value={newValues[f.key] || ''}
                    onChange={(e) => setNewValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none"
                  />
                </div>
              ))}
            </div>
            <button onClick={addRecord} className="bg-[var(--primary)] text-[#1a1400] font-bold text-xs rounded-lg px-3.5 py-2">
              افزودن
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl">
            <table className="w-full min-w-[420px] border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
              <thead>
                <tr className="text-[11px] text-[var(--text-3)]">
                  {selected.fields.map((f) => (
                    <th key={f.key} className="text-right px-3 py-2.5 border-b border-[var(--border)]">
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const values = JSON.parse(r.values_json || '{}');
                  return (
                    <tr key={r.id} className="text-[var(--text-2)]">
                      {selected.fields.map((f) => (
                        <td key={f.key} className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                          {values[f.key] ?? '—'}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {records.length === 0 && (
                  <tr>
                    <td colSpan={selected.fields.length} className="text-center text-[var(--text-3)] py-6">
                      هنوز رکوردی ثبت نشده
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 mt-4">
            <h3 className="font-bold text-xs mb-1">اتوماسیون — وقتی رکورد جدید ثبت شد...</h3>
            <p className="text-[10.5px] text-[var(--text-3)] mb-3">
              ماژول‌ها دیگه فقط فرم نیستن — هر قانون زیر با ثبت هر رکورد جدید در «{selected.name}» خودکار اجرا می‌شه.
            </p>

            <div className="flex flex-col gap-2 mb-3">
              {automations.length === 0 && (
                <div className="text-[11px] text-[var(--text-3)]">هنوز قانونی تعریف نشده.</div>
              )}
              {automations.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-xs font-bold">{ACTION_LABELS[a.action_type] || a.action_type}</div>
                    <div className="text-[10.5px] text-[var(--text-3)] truncate">
                      {a.action_type === 'create_task' ? a.config.titleTemplate : a.config.url}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => toggleAutomation(a)}
                      className={`text-[10.5px] font-bold rounded-md px-2 py-1 ${a.enabled ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--surface-3)] text-[var(--text-3)]'}`}
                    >
                      {a.enabled ? 'فعال' : 'غیرفعال'}
                    </button>
                    <button onClick={() => deleteAutomation(a)} className="text-[10.5px] text-[var(--danger)] font-bold px-1">
                      حذف
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={newAutomationType}
                onChange={(e) => setNewAutomationType(e.target.value as 'create_task' | 'webhook')}
                className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none"
              >
                <option value="create_task">ساخت وظیفه خودکار</option>
                <option value="webhook">ارسال Webhook</option>
              </select>
              {newAutomationType === 'create_task' ? (
                <input
                  value={newAutomationTitle}
                  onChange={(e) => setNewAutomationTitle(e.target.value)}
                  placeholder={`مثلاً: پیگیری {{${selected.fields[0]?.key || 'name'}}}`}
                  dir="rtl"
                  className="flex-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none"
                />
              ) : (
                <input
                  value={newAutomationUrl}
                  onChange={(e) => setNewAutomationUrl(e.target.value)}
                  placeholder="https://example.com/webhook"
                  dir="ltr"
                  className="flex-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none"
                />
              )}
              <button onClick={addAutomation} className="bg-[var(--primary)] text-[#1a1400] font-bold text-xs rounded-lg px-3.5 py-2 shrink-0">
                افزودن قانون
              </button>
            </div>
            {newAutomationType === 'create_task' && (
              <p className="text-[10px] text-[var(--text-3)] mt-1.5">
                می‌تونی از {'{{'}نام‌فیلد{'}}'}استفاده کنی تا مقدار همون فیلد رکورد جدید داخل عنوان وظیفه جایگذاری بشه.
              </p>
            )}
            {automationError && <div className="text-[10.5px] text-[var(--danger)] mt-1.5">{automationError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
