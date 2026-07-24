import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentOS — Agent-First Business OS',
  description: 'کسب‌وکارت رو با گفتگو اداره کن، نه فرم.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
