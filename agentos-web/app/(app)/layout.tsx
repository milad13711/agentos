import { redirect } from 'next/navigation';
import { backendFetch, BackendError } from '@/lib/backend';
import AppShell from '@/components/AppShell';

async function getMe() {
  try {
    return await backendFetch('/api/me');
  } catch (e) {
    if (e instanceof BackendError && (e.status === 401 || e.status === 403)) {
      redirect('/login');
    }
    throw e;
  }
}

const NAV = [
  { href: '/chat', label: '💬 گفتگو با Agent' },
  { href: '/deals', label: '💼 معاملات و سرنخ‌ها' },
  { href: '/contacts', label: '👤 مخاطبین' },
  { href: '/modules', label: '🧩 ماژول‌ها' },
  { href: '/marketplace', label: '🛒 Marketplace' },
  { href: '/tasks', label: '✅ وظایف و پیگیری' },
  { href: '/team', label: '👥 تیم و دسترسی‌ها' },
  { href: '/reports', label: '📊 گزارش‌ها' },
  { href: '/billing', label: '💳 صورت‌حساب و پلن' },
  { href: '/settings', label: '⚙️ شخصی‌سازی Agent' }
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  const nav = me.user.is_super_admin ? [...NAV, { href: '/admin', label: '🛡️ Super Admin' }] : NAV;

  return (
    <AppShell me={me} nav={nav}>
      {children}
    </AppShell>
  );
}
