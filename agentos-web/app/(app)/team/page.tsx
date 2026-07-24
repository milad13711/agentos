'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

type Member = { id: string; name: string; email: string; role: string; status: string; agent_name: string };

export default function TeamPage() {
  const [me, setMe] = useState<any>(null);
  const [team, setTeam] = useState<Member[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [inviteMsg, setInviteMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const [meRes, teamRes] = await Promise.all([api('me'), api('team')]);
    setMe(meRes);
    setTeam(teamRes);
  }
  useEffect(() => {
    load();
  }, []);

  const canManage = me && ['owner', 'admin'].includes(me.user.role);

  async function invite() {
    setInviteMsg(null);
    try {
      const res = await api('team/invite', { method: 'POST', body: JSON.stringify({ name, email, role }) });
      setInviteMsg({ ok: true, text: `${name} اضافه شد. رمز موقت: ${res.tempPassword}` });
      setName('');
      setEmail('');
      load();
    } catch (e: any) {
      setInviteMsg({ ok: false, text: e.message });
    }
  }
  async function changeRole(id: string, newRole: string) {
    await api(`team/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role: newRole }) });
    load();
  }
  async function remove(id: string) {
    if (!confirm('این پرسنل غیرفعال بشه؟')) return;
    await api(`team/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="p-6 overflow-y-auto">
      <h1 className="font-extrabold text-sm mb-4">تیم و سطوح دسترسی</h1>

      {canManage && (
        <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 mb-5">
          <h3 className="font-bold text-sm mb-3">افزودن پرسنل جدید</h3>
          <div className="flex gap-2 flex-wrap items-end">
            <div className="flex-1 min-w-[140px]">
              <label className="block text-[11px] text-[var(--text-3)] mb-1">نام</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none" />
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[11px] text-[var(--text-3)] mb-1">ایمیل</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none" />
            </div>
            <div className="min-w-[120px]">
              <label className="block text-[11px] text-[var(--text-3)] mb-1">نقش</label>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none">
                <option value="member">Member</option>
                {me.user.role === 'owner' && <option value="admin">Admin</option>}
              </select>
            </div>
            <button onClick={invite} className="bg-[var(--primary)] text-[#1a1400] font-bold text-sm rounded-lg px-4 py-2">
              دعوت
            </button>
          </div>
          {inviteMsg && (
            <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${inviteMsg.ok ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'text-[var(--danger)]'}`}>{inviteMsg.text}</div>
          )}
        </div>
      )}

      <table className="w-full border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
        <thead>
          <tr className="text-[11px] text-[var(--text-3)]">
            <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">نام</th>
            <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">ایمیل</th>
            <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">نقش</th>
            <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">Agent شخصی</th>
            {canManage && <th className="border-b border-[var(--border)]" />}
          </tr>
        </thead>
        <tbody>
          {team.map((u) => (
            <tr key={u.id} className="text-[var(--text-2)]">
              <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                <b className="text-[var(--text-1)]">{u.name}</b>
              </td>
              <td className="px-3 py-2.5 border-b border-[var(--border-soft)]" dir="ltr" style={{ textAlign: 'left' }}>
                {u.email}
              </td>
              <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                {canManage && u.role !== 'owner' ? (
                  <select value={u.role} onChange={(e) => changeRole(u.id, e.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1 text-xs">
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <span className="text-[10.5px] font-semibold bg-[var(--primary-soft)] text-[var(--primary)] px-2 py-0.5 rounded-full">{u.role}</span>
                )}
              </td>
              <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{u.agent_name || '—'}</td>
              {canManage && (
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  {u.role !== 'owner' && u.id !== me.user.id && (
                    <button onClick={() => remove(u.id)} className="bg-[var(--danger-soft)] text-[var(--danger)] rounded-md px-2.5 py-1 text-xs">
                      حذف
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-[var(--text-3)] mt-3">
        نقش <b>Owner</b> همیشه دسترسی کامل داره. <b>Admin</b> می‌تونه پرسنل مدیریت کنه. <b>Member</b> فقط به کار خودش و وظایف ارجاع‌شده دسترسی داره.
      </p>
    </div>
  );
}
