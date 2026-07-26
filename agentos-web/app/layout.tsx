import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentOS — Agent-First Business OS',
  description: 'کسب‌وکارت رو با گفتگو اداره کن، نه فرم.',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'AgentOS' },
  icons: { apple: '/icons/apple-touch-icon.png' }
};

export const viewport: Viewport = {
  themeColor: '#c9a227'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); }); }`
          }}
        />
      </body>
    </html>
  );
}
