'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

export default function SettingsPage() {
  const [agentName, setAgentName] = useState('');
  const [agentPersona, setAgentPersona] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api('me').then((me) => {
      setAgentName(me.user.agent_name || '');
      setAgentPersona(me.user.agent_persona || '');
    });
  }, []);

  async function save() {
    setMsg(null);
    try {
      await api('me/agent', { method: 'PATCH', body: JSON.stringify({ agentName, agentPersona }) });
      setMsg({ ok: true, text: '✓ ذخیره شد' });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message + ' — شخصی‌سازی شخصیت Agent از پلن Starter به بالا فعال می‌شه.' });
    }
  }

  return (
    <div className="p-4 md:p-6 overflow-y-auto">
      <h1 className="font-extrabold text-sm mb-4">شخصی‌سازی Agent شخصی من</h1>
      <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 max-w-md">
        <h3 className="font-bold text-sm mb-3">نام و شخصیت Agent</h3>
        <label className="block text-[11px] text-[var(--text-3)] mb-1">اسم Agent</label>
        <input
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="مثلاً: آریا"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none mb-3"
        />
        <label className="block text-[11px] text-[var(--text-3)] mb-1">شخصیت (چطور باهات صحبت کنه؟)</label>
        <textarea
          value={agentPersona}
          onChange={(e) => setAgentPersona(e.target.value)}
          rows={3}
          placeholder="مثلاً: رسمی و خیلی مختصر صحبت کن"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none mb-3"
        />
        <button onClick={save} className="bg-[var(--primary)] text-[#1a1400] font-bold text-sm rounded-lg px-4 py-2">
          ذخیره
        </button>
        {msg && <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${msg.ok ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'text-[var(--danger)]'}`}>{msg.text}</div>}
      </div>
    </div>
  );
}
