'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

type Field = { key: string; label: string; type: string };
type OwnModule = { id: string; name: string; entity_label: string; fields: Field[] };
type MarketItem = {
  id: string;
  name: string;
  entity_label: string;
  fields_json: string;
  published_by_tenant: string;
  installs: number;
  created_at: number;
};

export default function MarketplacePage() {
  const [ownModules, setOwnModules] = useState<OwnModule[]>([]);
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [mods, market] = await Promise.all([api('modules'), api('marketplace')]);
    setOwnModules(mods);
    setItems(market);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function publish(moduleId: string) {
    setBusyId(moduleId);
    setNotice(null);
    try {
      await api('marketplace/publish', { method: 'POST', body: JSON.stringify({ moduleId }) });
      setNotice('ماژول با موفقیت در Marketplace منتشر شد.');
      await load();
    } catch (e: any) {
      setNotice('خطا: ' + e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function install(itemId: string) {
    setBusyId(itemId);
    setNotice(null);
    try {
      await api(`marketplace/${itemId}/install`, { method: 'POST' });
      setNotice('ماژول نصب شد — از صفحه «ماژول‌ها» قابل استفاده‌ست.');
      await load();
    } catch (e: any) {
      setNotice('خطا: ' + e.message);
    } finally {
      setBusyId(null);
    }
  }

  const publishedNames = new Set(items.map((i) => i.name));

  if (loading) return <div className="p-4 md:p-6 text-sm text-[var(--text-3)]">در حال بارگذاری...</div>;

  return (
    <div className="p-4 md:p-6 overflow-y-auto overflow-x-hidden flex flex-col gap-8">
      <div>
        <h1 className="font-extrabold text-sm mb-1">Marketplace</h1>
        <p className="text-xs text-[var(--text-3)]">
          ماژول‌هایی که تنانت‌های دیگه ساختن و منتشر کردن رو نصب کن، یا ماژول خودت رو برای بقیه منتشر کن. فقط ساختار (فیلدها) به اشتراک گذاشته می‌شه — هیچ داده‌ی واقعی تو منتقل نمی‌شه.
        </p>
      </div>

      {notice && (
        <div className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 -mt-4">{notice}</div>
      )}

      <section>
        <h2 className="font-bold text-xs mb-3">ماژول‌های من — انتشار در Marketplace</h2>
        {ownModules.length === 0 ? (
          <div className="text-xs text-[var(--text-3)] bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl p-4">
            هنوز ماژولی نساختی. اول از صفحه «ماژول‌ها» یا با گفتگو با Agent یک ماژول بساز.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {ownModules.map((m) => {
              const already = publishedNames.has(m.name);
              return (
                <div key={m.id} className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl p-4">
                  <div className="font-bold text-sm mb-0.5">{m.name}</div>
                  <div className="text-[10.5px] text-[var(--text-3)] mb-3">{m.fields?.length ?? 0} فیلد</div>
                  <button
                    onClick={() => publish(m.id)}
                    disabled={busyId === m.id}
                    className="w-full text-center text-xs font-bold py-2 rounded-lg bg-[var(--primary)] text-[#1a1400] disabled:opacity-50"
                  >
                    {busyId === m.id ? '...' : already ? 'به‌روزرسانی انتشار' : 'انتشار در Marketplace'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-bold text-xs mb-3">ماژول‌های منتشرشده ({items.length})</h2>
        {items.length === 0 ? (
          <div className="text-xs text-[var(--text-3)] bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl p-4">
            هنوز هیچ ماژولی در Marketplace منتشر نشده.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {items.map((item) => {
              const fields: Field[] = JSON.parse(item.fields_json || '[]');
              return (
                <div key={item.id} className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl p-4 flex flex-col">
                  <div className="font-bold text-sm mb-0.5">{item.name}</div>
                  <div className="text-[10.5px] text-[var(--text-3)] mb-2">
                    {fields.map((f) => f.label).join('، ') || 'بدون فیلد'}
                  </div>
                  <div className="text-[10.5px] text-[var(--text-3)] mb-3">{item.installs} نصب</div>
                  <button
                    onClick={() => install(item.id)}
                    disabled={busyId === item.id}
                    className="mt-auto w-full text-center text-xs font-bold py-2 rounded-lg border border-[var(--border)] text-[var(--text-1)] disabled:opacity-50"
                  >
                    {busyId === item.id ? '...' : 'نصب'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
