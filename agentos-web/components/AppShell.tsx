'use client';

import { useState } from 'react';
import LogoutButton from './LogoutButton';
import NavLink from './NavLink';

type NavItem = { href: string; label: string };
type Me = { user: { name: string; role: string }; tenant: { name: string } };

// Desktop: fixed sidebar on the right (RTL), same as before. Mobile: the
// sidebar becomes an off-canvas drawer (hidden by default, slides in from
// the right where it visually "lives" on desktop too) opened via a
// hamburger button in a mobile-only top bar.
export default function AppShell({ me, nav, children }: { me: Me; nav: NavItem[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden">
      <header className="md:hidden flex items-center justify-between px-3 h-14 border-b border-[var(--border-soft)] bg-[var(--surface)] shrink-0">
        <button
          onClick={() => setOpen(true)}
          aria-label="باز کردن منو"
          className="w-9 h-9 flex items-center justify-center rounded-lg border border-[var(--border)] text-lg shrink-0"
        >
          ☰
        </button>
        <div className="flex items-center gap-2 font-extrabold text-sm">
          <div className="w-5 h-5 rounded-md bg-gradient-to-br from-[var(--primary)] to-[#9c7d1c]" />
          AgentOS
        </div>
        <div className="w-9 shrink-0" />
      </header>

      {open && (
        <div className="fixed inset-0 bg-black/60 z-40 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" />
      )}

      <aside
        className={`
          fixed md:static inset-y-0 right-0 z-50 w-72 md:w-56 max-w-[85vw]
          border-l border-[var(--border-soft)] bg-[var(--surface)] p-3 flex flex-col shrink-0
          transition-transform duration-200 ease-out md:transition-none
          ${open ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}
        `}
      >
        <div className="flex items-center justify-between px-2 pb-4">
          <div className="flex items-center gap-2 font-extrabold">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-[var(--primary)] to-[#9c7d1c]" />
            AgentOS
          </div>
          <button onClick={() => setOpen(false)} aria-label="بستن منو" className="md:hidden text-[var(--text-3)] text-lg w-8 h-8">
            ✕
          </button>
        </div>
        <nav className="flex flex-col gap-0.5 overflow-y-auto" onClick={() => setOpen(false)}>
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

      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">{children}</main>
    </div>
  );
}
