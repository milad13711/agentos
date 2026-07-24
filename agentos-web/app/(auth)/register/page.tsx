'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ tenantName: '', name: '', email: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'ثبت‌نام ناموفق بود');
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
        <h1 className="font-extrabold text-lg mb-1">ثبت‌نام سازمان جدید</h1>
        <p className="text-xs text-[var(--text-3)] mb-5">
          حساب داری؟ <Link href="/login" className="text-[var(--primary)]">وارد شو</Link>
        </p>
        {[
          ['tenantName', 'نام شرکت', 'text'],
          ['name', 'نام شما', 'text'],
          ['email', 'ایمیل', 'email'],
          ['password', 'رمز عبور (حداقل ۸ کاراکتر)', 'password']
        ].map(([key, label, type]) => (
          <div key={key} className="mb-3">
            <label className="block text-xs text-[var(--text-3)] mb-1">{label}</label>
            <input
              type={type}
              required
              value={(form as any)[key]}
              onChange={(e) => set(key, e.target.value)}
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm outline-none"
            />
          </div>
        ))}
        {err && <div className="text-xs text-[var(--danger)] mb-3">{err}</div>}
        <button
          disabled={loading}
          className="w-full bg-[var(--primary)] text-[#1a1400] font-bold text-sm rounded-lg py-2.5 disabled:opacity-50"
        >
          {loading ? '...' : 'ثبت‌نام'}
        </button>
      </form>
    </main>
  );
}
