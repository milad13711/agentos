'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

type Contact = { id: string; name: string; phone: string; company: string; created_at: number };

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ name: '', phone: '', company: '' });

  async function load() {
    setLoading(true);
    setContacts(await api('contacts'));
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function addContact() {
    if (!form.name.trim()) return;
    await api('contacts', { method: 'POST', body: JSON.stringify(form) });
    setForm({ name: '', phone: '', company: '' });
    load();
  }
  async function removeContact(id: string) {
    if (!confirm('این مخاطب حذف بشه؟')) return;
    await api(`contacts/${id}`, { method: 'DELETE' });
    load();
  }

  const shown = q ? contacts.filter((c) => c.name.includes(q) || (c.phone || '').includes(q) || (c.company || '').includes(q)) : contacts;

  return (
    <div className="p-4 md:p-6 overflow-y-auto">
      <h1 className="font-extrabold text-sm mb-4">مخاطبین</h1>

      <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 mb-4">
        <h3 className="font-bold text-xs mb-2.5">مخاطب جدید</h3>
        <div className="flex gap-2.5 flex-wrap items-end">
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[10.5px] text-[var(--text-3)] mb-1">نام</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none" />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[10.5px] text-[var(--text-3)] mb-1">تلفن</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none" dir="ltr" />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[10.5px] text-[var(--text-3)] mb-1">شرکت</label>
            <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none" />
          </div>
          <button onClick={addContact} className="bg-[var(--primary)] text-[#1a1400] font-bold text-xs rounded-lg px-4 py-2">
            افزودن
          </button>
        </div>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="جستجو بر اساس نام، تلفن یا شرکت..."
        className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-xl px-3.5 py-2.5 text-sm outline-none mb-3"
      />

      <div className="overflow-x-auto rounded-xl">
        <table className="w-full min-w-[480px] border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
          <thead>
            <tr className="text-[11px] text-[var(--text-3)]">
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">نام</th>
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">تلفن</th>
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">شرکت</th>
              <th className="border-b border-[var(--border)]" />
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} className="text-[var(--text-2)]">
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]"><b className="text-[var(--text-1)]">{c.name}</b></td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]" dir="ltr" style={{ textAlign: 'left' }}>{c.phone || '—'}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{c.company || '—'}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <button onClick={() => removeContact(c.id)} className="bg-[var(--danger-soft)] text-[var(--danger)] rounded-md px-2.5 py-1 text-xs">حذف</button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={4} className="text-center text-[var(--text-3)] py-6">موردی یافت نشد</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
