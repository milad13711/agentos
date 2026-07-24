'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Link
      href={href}
      className={`text-sm font-semibold px-3 py-2 rounded-lg mb-0.5 ${
        active ? 'bg-[var(--primary-soft)] text-[var(--primary)]' : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
      }`}
    >
      {label}
    </Link>
  );
}
