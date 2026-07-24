'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

type Plan = { key: string; name: string; priceMonthlyToman: number; priceYearlyToman: number };
type Payment = { id: string; plan_key: string; billing_cycle: string; amount_toman: number; status: string; ref_id: string | null; created_at: number };

function BillingContent() {
  const params = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [currentPlan, setCurrentPlan] = useState('');
  const [role, setRole] = useState('');
  const [history, setHistory] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const paymentStatus = params.get('payment');

  async function load() {
    const [plansRes, meRes, historyRes] = await Promise.all([api('plans'), api('me'), api('billing/history')]);
    setPlans(plansRes);
    setCurrentPlan(meRes.tenant.plan_key);
    setRole(meRes.user.role);
    setHistory(historyRes);
    setLoading(false);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function subscribe(planKey: string, billingCycle: 'monthly' | 'yearly') {
    setErr(null);
    setBusy(`${planKey}-${billingCycle}`);
    try {
      const res = await api('billing/subscribe', { method: 'POST', body: JSON.stringify({ planKey, billingCycle }) });
      window.location.href = res.redirectUrl; // real navigation to Zarinpal's checkout page
    } catch (e: any) {
      setErr(e.message);
      setBusy(null);
    }
  }

  const canManage = ['owner', 'admin'].includes(role);

  return (
    <div className="p-6 overflow-y-auto">
      <h1 className="font-extrabold text-sm mb-4">صورت‌حساب و پلن</h1>

      {paymentStatus === 'success' && (
        <div className="bg-[var(--success-soft)] text-[var(--success)] rounded-xl px-4 py-3 text-sm mb-4">
          ✅ پرداخت با موفقیت تایید شد و پلن شما ارتقا یافت.
        </div>
      )}
      {paymentStatus === 'error' && (
        <div className="bg-[var(--danger-soft)] text-[var(--danger)] rounded-xl px-4 py-3 text-sm mb-4">
          ✖️ پرداخت ناموفق بود یا لغو شد. ({params.get('message') || 'خطای نامشخص'})
        </div>
      )}
      {err && <div className="bg-[var(--danger-soft)] text-[var(--danger)] rounded-xl px-4 py-3 text-sm mb-4">{err}</div>}

      {!loading && (
        <>
          <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 mb-5">
            <div className="text-xs text-[var(--text-3)] mb-1">پلن فعلی</div>
            <div className="font-extrabold text-lg text-[var(--primary)]">
              {plans.find((p) => p.key === currentPlan)?.name || currentPlan}
            </div>
          </div>

          {!canManage && (
            <div className="text-xs text-[var(--text-3)] bg-[var(--surface)] border border-dashed border-[var(--border)] rounded-xl px-4 py-3 mb-5">
              فقط Owner یا Admin می‌تونه پلن رو ارتقا بده.
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
            {plans.filter((p) => p.key !== 'free').map((p) => (
              <div key={p.key} className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4">
                <div className="font-extrabold mb-2">{p.name}</div>
                <div className="text-xs text-[var(--text-3)] mb-1">ماهانه: {p.priceMonthlyToman.toLocaleString('en-US')} تومان</div>
                <div className="text-xs text-[var(--text-3)] mb-3">سالانه: {p.priceYearlyToman.toLocaleString('en-US')} تومان</div>
                {canManage && currentPlan !== p.key && (
                  <div className="flex gap-2">
                    <button
                      disabled={busy === `${p.key}-monthly`}
                      onClick={() => subscribe(p.key, 'monthly')}
                      className="flex-1 border border-[var(--border)] rounded-lg py-2 text-xs disabled:opacity-50"
                    >
                      {busy === `${p.key}-monthly` ? '...' : 'ماهانه'}
                    </button>
                    <button
                      disabled={busy === `${p.key}-yearly`}
                      onClick={() => subscribe(p.key, 'yearly')}
                      className="flex-1 bg-[var(--primary)] text-[#1a1400] font-bold rounded-lg py-2 text-xs disabled:opacity-50"
                    >
                      {busy === `${p.key}-yearly` ? '...' : 'سالانه'}
                    </button>
                  </div>
                )}
                {currentPlan === p.key && <div className="text-xs text-[var(--success)] text-center py-2">پلن فعلی شماست</div>}
              </div>
            ))}
          </div>

          <h3 className="font-bold text-xs mb-2.5">تاریخچه پرداخت‌ها</h3>
          <table className="w-full border-collapse bg-[var(--surface)] border border-[var(--border-soft)] rounded-xl overflow-hidden text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--text-3)]">
                <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">پلن</th>
                <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">دوره</th>
                <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">مبلغ</th>
                <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">وضعیت</th>
                <th className="text-right px-3 py-2.5 border-b border-[var(--border)]">کد پیگیری</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="text-[var(--text-2)]">
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{h.plan_key}</td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{h.billing_cycle === 'yearly' ? 'سالانه' : 'ماهانه'}</td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">{h.amount_toman.toLocaleString('en-US')} تومان</td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]">
                    <span
                      className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${
                        h.status === 'paid' ? 'bg-[var(--success-soft)] text-[var(--success)]' : h.status === 'failed' ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : 'bg-[var(--info-soft)] text-[var(--info)]'
                      }`}
                    >
                      {h.status === 'paid' ? 'موفق' : h.status === 'failed' ? 'ناموفق' : 'در انتظار'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 border-b border-[var(--border-soft)]" dir="ltr" style={{ textAlign: 'left' }}>{h.ref_id || '—'}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={5} className="text-center text-[var(--text-3)] py-6">هنوز پرداختی ثبت نشده</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-[var(--text-3)]">در حال بارگذاری...</div>}>
      <BillingContent />
    </Suspense>
  );
}
