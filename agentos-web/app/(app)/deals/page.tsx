'use client';

import { Fragment, useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

const STAGES = ['سرنخ', 'در حال مذاکره', 'پیشنهاد ارسال‌شده', 'برنده', 'ازدست‌رفته'];

type Deal = { id: string; title: string; contact_name: string; amount: number | null; stage: string; created_at: number };
type Interaction = { id: string; note: string; created_at: number };

function fmtDate(ts: number) {
  return new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
}

// Same running interaction history as contacts (see contacts/page.tsx) — a
// "لید" here IS a deal with stage='سرنخ', so notes on it live in the exact
// same table/endpoint shape, just scoped to /api/deals/:id/interactions.
function DealDetail({ dealId }: { dealId: string }) {
  const [notes, setNotes] = useState<Interaction[]>([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [loadingNotes, setLoadingNotes] = useState(true);

  async function loadNotes() {
    setLoadingNotes(true);
    setNotes(await api(`deals/${dealId}/interactions`));
    setLoadingNotes(false);
  }
  useEffect(() => {
    loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  async function addNote() {
    if (!noteDraft.trim()) return;
    await api(`deals/${dealId}/interactions`, { method: 'POST', body: JSON.stringify({ note: noteDraft.trim() }) });
    setNoteDraft('');
    loadNotes();
  }

  return (
    <div className="bg-[var(--surface-2)] rounded-xl p-3.5 mt-1 mb-2">
      <h4 className="font-bold text-xs mb-2">یادداشت‌ها و تاریخچه ارتباط</h4>
      <div className="flex gap-2 mb-2">
        <input
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addNote()}
          placeholder="مثلاً: تماس گرفتم، پیشنهاد قیمت رو فرستادم"
          className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none"
        />
        <button onClick={addNote} className="bg-[var(--primary)] text-[#1a1400] font-bold text-xs rounded-lg px-3 py-1.5 shrink-0">
          ثبت
        </button>
      </div>
      {!loadingNotes && (
        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto overflow-x-hidden">
          {notes.length === 0 && <div className="text-[11px] text-[var(--text-3)]">هنوز یادداشتی ثبت نشده</div>}
          {notes.map((n) => (
            <div key={n.id} className="text-[11px] bg-[var(--surface)] border border-[var(--border-soft)] rounded-lg px-2.5 py-1.5">
              <div className="text-[var(--text-2)]">{n.note}</div>
              <div className="text-[10px] text-[var(--text-3)] mt-0.5">{fmtDate(n.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DealsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStage, setFilterStage] = useState('');
  const [form, setForm] = useState({ title: '', contactName: '', amount: '', stage: 'سرنخ' });
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
              <Fragment key={d.id}>
                <tr className="text-[var(--text-2)]">
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]"><b className="text-[var(--text-1)]">{d.title}</b></td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{d.contact_name || '—'}</td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{d.amount != null ? d.amount.toLocaleString('en-US') + ' تومان' : '—'}</td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                    <select value={d.stage} onChange={(e) => changeStage(d.id, e.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1 text-xs">
                      {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)] whitespace-nowrap">
                    <button
                      onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}
                      className="border border-[var(--border)] rounded-md px-2.5 py-1 text-xs ml-1.5"
                    >
                      {expandedId === d.id ? 'بستن' : 'یادداشت‌ها'}
                    </button>
                    <button onClick={() => removeDeal(d.id)} className="bg-[var(--danger-soft)] text-[var(--danger)] rounded-md px-2.5 py-1 text-xs">حذف</button>
                  </td>
                </tr>
                {expandedId === d.id && (
                  <tr>
                    <td colSpan={5} className="px-3 pb-2">
                      <DealDetail dealId={d.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
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
