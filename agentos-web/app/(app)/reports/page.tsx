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

    // Built with DOM APIs (textContent, not innerHTML/document.write) so a
    // record whose name/title contains "<script>..." or similar can never
    // execute here — every row value below is user-entered CRM data
    // (contact names, deal titles, ...), so it must be treated as untrusted.
    const doc = w.document;
    doc.open();
    doc.write('<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    doc.title = `گزارش ${key}`;
    const style = doc.createElement('style');
    style.textContent = 'body{font-family:Tahoma,sans-serif;padding:24px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #999;padding:6px}';
    doc.head.appendChild(style);

    const h2 = doc.createElement('h2');
    h2.textContent = `گزارش ${key}`;
    doc.body.appendChild(h2);

    const table = doc.createElement('table');
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    cols.forEach((c) => {
      const th = doc.createElement('th');
      th.textContent = c;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = doc.createElement('tbody');
    rows.forEach((r: any) => {
      const tr = doc.createElement('tr');
      cols.forEach((c) => {
        const td = doc.createElement('td');
        td.textContent = r[c] ?? '';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    doc.body.appendChild(table);

    w.print();
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
