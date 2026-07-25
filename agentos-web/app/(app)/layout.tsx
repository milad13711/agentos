import { redirect } from 'next/navigation';
import { backendFetch, BackendError } from '@/lib/backend';
import LogoutButton from '@/components/LogoutButton';
import NavLink from '@/components/NavLink';

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
    <div className="flex h-screen">
      <aside className="w-56 border-l border-[var(--border-soft)] bg-[var(--surface)] p-3 flex flex-col shrink-0">
        <div className="flex items-center gap-2 font-extrabold px-2 pb-4">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-[var(--primary)] to-[#9c7d1c]" />
          AgentOS
        </div>
        <nav className="flex flex-col gap-0.5">
          {nav.map((n) => (
            <NavLink key={n.href} href={n.href} label={n.label} />
          ))}
        </nav>
        <div className="flex-1" />
        <div className="text-xs text-[var(--text-3)] border-t border-[var(--border-soft)] pt-3 px-2">
          <b className="block text-[var(--text-2)] text-[13px]">{me.user.name}</b>
          {me.tenant.name} ·{' '}
          <span className="text-[10.5px] font-semibold bg-[var(--primary-soft)] text-[var(--primary)] px-2 py-0.5 rounded-full">
            {me.user.role}
          </span>
        </div>
        <LogoutButton />
      </aside>
      <main className="flex-1 min-w-0 flex flex-col">{children}</main>
    </div>
  );
}
