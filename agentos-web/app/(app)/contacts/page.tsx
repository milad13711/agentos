'use client';

import { Fragment, useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

type Contact = { id: string; name: string; phone: string; company: string; telegram_chat_id: string | null; created_at: number };
type Interaction = { id: string; note: string; created_at: number };

function fmtDate(ts: number) {
  return new Date(ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
}

// Expandable panel per contact: interaction history (every logged touch —
// call, message, meeting — kept as a running note trail, never overwritten)
// plus Telegram linking/messaging for that specific customer/lead.
function ContactDetail({ contact, onLinkedChange }: { contact: Contact; onLinkedChange: () => void }) {
  const [notes, setNotes] = useState<Interaction[]>([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [loadingNotes, setLoadingNotes] = useState(true);
  const [linkCode, setLinkCode] = useState<{ code: string; botUsername: string | null; deepLink: string | null } | null>(null);
  const [messageDraft, setMessageDraft] = useState('');
  const [tgMsg, setTgMsg] = useState<string | null>(null);

  async function loadNotes() {
    setLoadingNotes(true);
    setNotes(await api(`contacts/${contact.id}/interactions`));
    setLoadingNotes(false);
  }
  useEffect(() => {
    loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id]);

  async function addNote() {
    if (!noteDraft.trim()) return;
    await api(`contacts/${contact.id}/interactions`, { method: 'POST', body: JSON.stringify({ note: noteDraft.trim() }) });
    setNoteDraft('');
    loadNotes();
  }

  async function getLinkCode() {
    setTgMsg(null);
    try {
      setLinkCode(await api(`contacts/${contact.id}/telegram/link-code`, { method: 'POST' }));
    } catch (e: any) {
      setTgMsg('خطا: ' + e.message);
    }
  }
  async function unlinkTelegram() {
    setTgMsg(null);
    try {
      await api(`contacts/${contact.id}/telegram`, { method: 'DELETE' });
      onLinkedChange();
    } catch (e: any) {
      setTgMsg('خطا: ' + e.message);
    }
  }
  async function sendMessage() {
    if (!messageDraft.trim()) return;
    setTgMsg(null);
    try {
      await api(`contacts/${contact.id}/message`, { method: 'POST', body: JSON.stringify({ message: messageDraft.trim() }) });
      setTgMsg('✓ پیام ارسال شد.');
      setMessageDraft('');
      loadNotes();
    } catch (e: any) {
      setTgMsg('خطا: ' + e.message);
    }
  }

  return (
    <div className="bg-[var(--surface-2)] rounded-xl p-3.5 mt-1 mb-2 flex flex-col md:flex-row gap-4">
      <div className="flex-1 min-w-0">
        <h4 className="font-bold text-xs mb-2">یادداشت‌ها و تاریخچه ارتباط</h4>
        <div className="flex gap-2 mb-2">
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNote()}
            placeholder="مثلاً: تماس گرفتم، قرار هفته بعد گذاشتیم"
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

      <div className="md:w-64 shrink-0 border-t md:border-t-0 md:border-r border-[var(--border)] pt-3 md:pt-0 md:pr-4">
        <h4 className="font-bold text-xs mb-2">پیام تلگرام به این مشتری</h4>
        {contact.telegram_chat_id ? (
          <>
            <div className="text-[11px] text-[var(--success)] bg-[var(--success-soft)] rounded-lg px-2.5 py-1.5 mb-2">✓ تلگرام این مشتری وصله</div>
            <div className="flex gap-2 mb-2">
              <input
                value={messageDraft}
                onChange={(e) => setMessageDraft(e.target.value)}
                placeholder="متن پیام..."
                className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-xs outline-none"
              />
              <button onClick={sendMessage} className="bg-[var(--primary)] text-[#1a1400] font-bold text-xs rounded-lg px-3 py-1.5 shrink-0">
                ارسال
              </button>
            </div>
            <button onClick={unlinkTelegram} className="text-[10.5px] text-[var(--danger)] font-bold">
              قطع اتصال تلگرام
            </button>
          </>
        ) : !linkCode ? (
          <button onClick={getLinkCode} className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs">
            گرفتن لینک اتصال تلگرام
          </button>
        ) : (
          <div className="text-[11px] text-[var(--text-2)]">
            <p className="mb-1.5">این لینک رو برای مشتری بفرست (پیامک/واتساپ) تا با زدنش تلگرامش به AgentOS وصل بشه:</p>
            {linkCode.deepLink ? (
              <a href={linkCode.deepLink} target="_blank" rel="noreferrer" dir="ltr" className="block text-center bg-[var(--surface)] border border-[var(--border)] rounded-lg py-1.5 mb-1.5 select-all break-all text-[10.5px]">
                {linkCode.deepLink}
              </a>
            ) : (
              <div dir="ltr" className="text-center font-mono bg-[var(--surface)] border border-[var(--border)] rounded-lg py-1.5 mb-1.5 select-all">
                /start contact_{linkCode.code}
              </div>
            )}
            <p className="text-[10px] text-[var(--text-3)] mb-1.5">تا ۱۰ دقیقه دیگه معتبره.</p>
            <button onClick={onLinkedChange} className="text-[10.5px] text-[var(--primary)] font-bold">
              وصل شد — بررسی کن
            </button>
          </div>
        )}
        {tgMsg && <div className="mt-2 text-[10.5px] text-[var(--text-3)]">{tgMsg}</div>}
      </div>
    </div>
  );
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ name: '', phone: '', company: '' });
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
    <div className="p-4 md:p-6 overflow-y-auto overflow-x-hidden">
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
              <Fragment key={c.id}>
                <tr className="text-[var(--text-2)]">
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]"><b className="text-[var(--text-1)]">{c.name}</b></td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]" dir="ltr" style={{ textAlign: 'left' }}>{c.phone || '—'}</td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{c.company || '—'}</td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)] whitespace-nowrap">
                    <button
                      onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                      className="border border-[var(--border)] rounded-md px-2.5 py-1 text-xs ml-1.5"
                    >
                      {expandedId === c.id ? 'بستن' : 'یادداشت‌ها'}
                    </button>
                    <button onClick={() => removeContact(c.id)} className="bg-[var(--danger-soft)] text-[var(--danger)] rounded-md px-2.5 py-1 text-xs">حذف</button>
                  </td>
                </tr>
                {expandedId === c.id && (
                  <tr>
                    <td colSpan={4} className="px-3 pb-2">
                      <ContactDetail contact={c} onLinkedChange={load} />
                    </td>
                  </tr>
                )}
              </Fragment>
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
