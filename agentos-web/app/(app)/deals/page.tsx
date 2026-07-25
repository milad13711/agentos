'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

const STAGES = ['سرنخ', 'در حال مذاکره', 'پیشنهاد ارسال‌شده', 'برنده', 'ازدست‌رفته'];

type Deal = { id: string; title: string; contact_name: string; amount: number | null; stage: string; created_at: number };

export default function DealsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStage, setFilterStage] = useState('');
  const [form, setForm] = useState({ title: '', contactName: '', amount: '', stage: 'سرنخ' });

  async function load() {
    setLoading(true);
    setDeals(await api('deals'));
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function addDeal() {
    if (!form.title.trim()) return;
    await api('deals', {
      method: 'POST',
      body: JSON.stringify({ title: form.title, contactName: form.contactName, amount: form.amount ? Number(form.amount) : null, stage: form.stage })
    });
    setForm({ title: '', contactName: '', amount: '', stage: 'سرنخ' });
    load();
  }
  async function changeStage(id: string, stage: string) {
    await api(`deals/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage }) });
    load();
  }
  async function removeDeal(id: string) {
    if (!confirm('این معامله حذف بشه؟')) return;
    await api(`deals/${id}`, { method: 'DELETE' });
    load();
  }

  const shown = filterStage ? deals.filter((d) => d.stage === filterStage) : deals;
  const pipelineValue = shown.filter((d) => d.stage !== 'برنده' && d.stage !== 'ازدست‌رفته').reduce((s, d) => s + (d.amount || 0), 0);

  return (
    <div className="p-4 md:p-6 overflow-y-auto overflow-x-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-4">
        <h1 className="font-extrabold text-sm">معاملات و سرنخ‌ها</h1>
        <div className="text-xs text-[var(--text-3)]">ارزش پایپ‌لاین: {pipelineValue.toLocaleString('en-US')} تومان</div>
      </div>

      <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 mb-4">
        <h3 className="font-bold text-xs mb-2.5">معامله/سرنخ جدید</h3>
        <div className="flex gap-2.5 flex-wrap items-end">
          <div className="flex-1 min-w-[150px]">
            <label className="block text-[10.5px] text-[var(--text-3)] mb-1">عنوان</label>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none" />
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-[10.5px] text-[var(--text-3)] mb-1">مخاطب (نام و/یا تلفن)</label>
            <input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none" />
          </div>
          <div className="w-32">
            <label className="block text-[10.5px] text-[var(--text-3)] mb-1">مبلغ (تومان)</label>
            <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none" />
          </div>
          <div className="w-36">
            <label className="block text-[10.5px] text-[var(--text-3)] mb-1">مرحله</label>
            <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none">
              {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <button onClick={addDeal} className="bg-[var(--primary)] text-[#1a1400] font-bold text-xs rounded-lg px-4 py-2">
            افزودن
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <button onClick={() => setFilterStage('')} className={`text-[11px] px-3 py-1.5 rounded-full ${!filterStage ? 'bg-[var(--primary-soft)] text-[var(--primary)]' : 'bg-[var(--surface-2)] text-[var(--text-3)]'}`}>
          همه
        </button>
        {STAGES.map((s) => (
          <button key={s} onClick={() => setFilterStage(s)} className={`text-[11px] px-3 py-1.5 rounded-full ${filterStage === s ? 'bg-[var(--primary-soft)] text-[var(--primary)]' : 'bg-[var(--surface-2)] text-[var(--text-3)]'}`}>
            {s} ({deals.filter((d) => d.stage === s).length})
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl">
        <table className="w-full min-w-[560px] border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
          <thead>
            <tr className="text-[11px] text-[var(--text-3)]">
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">عنوان</th>
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">مخاطب</th>
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">مبلغ</th>
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">مرحله</th>
              <th className="border-b border-[var(--border)]" />
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="text-[var(--text-2)]">
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]"><b className="text-[var(--text-1)]">{d.title}</b></td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{d.contact_name || '—'}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{d.amount != null ? d.amount.toLocaleString('en-US') + ' تومان' : '—'}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <select value={d.stage} onChange={(e) => changeStage(d.id, e.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1 text-xs">
                    {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <button onClick={() => removeDeal(d.id)} className="bg-[var(--danger-soft)] text-[var(--danger)] rounded-md px-2.5 py-1 text-xs">حذف</button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={5} className="text-center text-[var(--text-3)] py-6">موردی یافت نشد</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
