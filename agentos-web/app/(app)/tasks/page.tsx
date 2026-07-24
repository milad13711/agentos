'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

type Task = { id: string; title: string; assignee_id: string; assignee_name: string; due_at: number | null; status: string };
type Member = { id: string; name: string };

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [team, setTeam] = useState<Member[]>([]);
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    const [t, m] = await Promise.all([api('tasks'), api('team')]);
    setTasks(t);
    setTeam(m);
    if (!assigneeId && m[0]) setAssigneeId(m[0].id);
    setLoading(false);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addTask() {
    if (!title.trim()) return;
    await api('tasks', {
      method: 'POST',
      body: JSON.stringify({ title, assigneeId, dueAt: dueDate ? new Date(dueDate).getTime() : null })
    });
    setTitle('');
    load();
  }
  async function markDone(id: string) {
    await api(`tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    load();
  }
  async function delegate(id: string, newAssigneeId: string) {
    await api(`tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: newAssigneeId }) });
    load();
  }

  return (
    <div className="p-6 overflow-y-auto">
      <h1 className="font-extrabold text-sm mb-4">وظایف، یادآورها و پیگیری‌ها</h1>

      <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 mb-5">
        <h3 className="font-bold text-sm mb-3">وظیفه جدید</h3>
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[11px] text-[var(--text-3)] mb-1">عنوان</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none" />
          </div>
          <div className="min-w-[140px]">
            <label className="block text-[11px] text-[var(--text-3)] mb-1">مسئول</label>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none">
              {team.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="max-w-[160px]">
            <label className="block text-[11px] text-[var(--text-3)] mb-1">موعد</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none" />
          </div>
          <button onClick={addTask} className="bg-[var(--primary)] text-[#1a1400] font-bold text-sm rounded-lg px-4 py-2">
            افزودن
          </button>
        </div>
      </div>

      {!loading && (
        <table className="w-full border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
          <thead>
            <tr className="text-[11px] text-[var(--text-3)]">
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">عنوان</th>
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">مسئول</th>
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">وضعیت</th>
              <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">ارجاع به</th>
              <th className="border-b border-[var(--border)]" />
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="text-[var(--text-2)]">
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <b className="text-[var(--text-1)]">{t.title}</b>
                </td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{t.assignee_name || '—'}</td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${t.status === 'open' ? 'bg-[var(--info-soft)] text-[var(--info)]' : 'bg-[var(--success-soft)] text-[var(--success)]'}`}>
                    {t.status === 'open' ? 'باز' : 'انجام‌شده'}
                  </span>
                </td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  <select value={t.assignee_id} onChange={(e) => delegate(t.id, e.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1 text-xs">
                    {team.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                  {t.status === 'open' && (
                    <button onClick={() => markDone(t.id)} className="border border-[var(--border)] rounded-md px-2.5 py-1 text-xs">
                      ✓ انجام شد
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-[var(--text-3)] py-6">
                  وظیفه‌ای ثبت نشده
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
