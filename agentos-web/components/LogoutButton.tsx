'use client';

import { useRouter } from 'next/navigation';

export default function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }
  return (
    <button onClick={logout} className="text-xs text-[var(--text-3)] px-2 py-2 text-right hover:text-[var(--text-1)]">
      خروج از حساب
    </button>
  );
}
