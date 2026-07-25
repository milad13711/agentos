'use client';

const REPORTS: [string, string][] = [
  ['deals', 'معاملات'],
  ['contacts', 'مخاطبین'],
  ['invoices', 'فاکتورها'],
  ['tasks', 'وظایف']
];

export default function ReportsPage() {
  function downloadXlsx(key: string) {
    window.open(`/api/proxy/reports/${key}.xlsx`, '_blank');
  }

  async function printPdf(key: string) {
    const res = await fetch(`/api/proxy/${key === 'tasks' ? 'tasks' : key}`);
    const rows = await res.json();
    const w = window.open('', '_blank');
    if (!w) return;
    const cols = Object.keys(rows[0] || {});
    w.document.write(`
      <html dir="rtl"><head><meta charset="utf-8"><title>گزارش ${key}</title></head>
      <body style="font-family:Tahoma,sans-serif;padding:24px">
        <h2>گزارش ${key}</h2>
        <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
          <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r: any) => `<tr>${cols.map((c) => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
        <script>window.print()</script>
      </body></html>
    `);
    w.document.close();
  }

  return (
    <div className="p-4 md:p-6 overflow-y-auto overflow-x-hidden">
      <h1 className="font-extrabold text-sm mb-4">گزارش‌ها</h1>
      <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 max-w-lg">
        <h3 className="font-bold text-sm mb-1">دانلود گزارش</h3>
        <p className="text-xs text-[var(--text-3)] mb-4">
          Excel (.xlsx واقعی) مستقیم از سرور دانلود می‌شه. PDF از طریق چاپ مرورگر ساخته می‌شه تا فارسی/RTL درست رندر بشه.
        </p>
        {REPORTS.map(([key, label]) => (
          <div key={key} className="flex flex-wrap items-center gap-2.5 mb-2.5">
            <div className="flex-1 min-w-[70px] text-sm">{label}</div>
            <button onClick={() => downloadXlsx(key)} className="border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs whitespace-nowrap">
              ⬇ Excel
            </button>
            <button onClick={() => printPdf(key)} className="border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs whitespace-nowrap">
              🖨 PDF
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
