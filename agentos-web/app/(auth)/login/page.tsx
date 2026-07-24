'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'ورود ناموفق بود');
      router.push('/chat');
      router.refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-7">
        <h1 className="font-extrabold text-lg mb-1">ورود به AgentOS</h1>
        <p className="text-xs text-[var(--text-3)] mb-5">
          حساب نداری؟ <Link href="/register" className="text-[var(--primary)]">ثبت‌نام کن</Link>
        </p>
        <label className="block text-xs text-[var(--text-3)] mb-1">ایمیل</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm mb-3 outline-none"
        />
        <label className="block text-xs text-[var(--text-3)] mb-1">رمز عبور</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm mb-4 outline-none"
        />
        {err && <div className="text-xs text-[var(--danger)] mb-3">{err}</div>}
        <button
          disabled={loading}
          className="w-full bg-[var(--primary)] text-[#1a1400] font-bold text-sm rounded-lg py-2.5 disabled:opacity-50"
        >
          {loading ? '...' : 'ورود'}
        </button>
      </form>
    </main>
  );
}
