import Link from 'next/link';
import { backendFetchPublic } from '@/lib/backend';

type Plan = {
  key: string;
  name: string;
  priceMonthlyToman: number;
  priceYearlyToman: number;
  features: Record<string, boolean>;
};

async function getPlans(): Promise<Plan[]> {
  try {
    return await backendFetchPublic('/api/plans');
  } catch {
    // Fallback so the marketing page still renders if the backend is briefly unreachable.
    return [
      { key: 'free', name: 'رایگان', priceMonthlyToman: 0, priceYearlyToman: 0, features: {} },
      { key: 'starter', name: 'استارتاپی', priceMonthlyToman: 990000, priceYearlyToman: 9900000, features: {} },
      { key: 'pro', name: 'حرفه‌ای', priceMonthlyToman: 2990000, priceYearlyToman: 29900000, features: {} },
      { key: 'enterprise', name: 'سازمانی', priceMonthlyToman: 9900000, priceYearlyToman: 99000000, features: {} }
    ];
  }
}

function toman(n: number) {
  if (n === 0) return 'رایگان';
  return n.toLocaleString('en-US') + ' تومان';
}

const FEATURE_ROWS: Record<string, string[]> = {
  free: ['۱ کاربر', '۵۰ اکشن Agent در ماه', '۱ ماژول سفارشی', 'بدون Marketplace', 'پشتیبانی انجمن'],
  starter: ['تا ۵ کاربر', '۵۰۰ اکشن Agent در ماه', 'تا ۳ ماژول سفارشی', 'نصب از Marketplace', 'شخصی‌سازی Agent + پشتیبانی ایمیلی'],
  pro: ['تا ۲۰ کاربر', 'اکشن Agent نامحدود', 'ماژول سفارشی نامحدود', 'انتشار در Marketplace', 'گفتگوی صوتی با Agent', 'پشتیبانی اولویت‌دار'],
  enterprise: ['کاربر نامحدود', 'SSO و White-label', 'SLA اختصاصی', 'Onboarding اختصاصی', 'پشتیبانی ۲۴/۷ اختصاصی']
};

export default async function HomePage() {
  const plans = await getPlans();
  const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));

  return (
    <main className="min-h-screen">
      <header className="flex items-center justify-between px-8 py-5 border-b border-[var(--border-soft)]">
        <div className="flex items-center gap-2 font-extrabold">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--primary)] to-[#9c7d1c]" />
          AgentOS
        </div>
        <nav className="flex gap-3">
          <Link href="/login" className="text-sm text-[var(--text-2)] px-4 py-2 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)]">
            ورود
          </Link>
          <Link href="/register" className="text-sm font-bold px-4 py-2 rounded-lg bg-[var(--primary)] text-[#1a1400]">
            شروع رایگان
          </Link>
        </nav>
      </header>

      <section className="text-center px-6 py-16 max-w-2xl mx-auto">
        <div className="inline-block text-xs font-semibold text-[var(--primary)] bg-[var(--primary-soft)] px-3 py-1 rounded-full mb-4">
          اولین Agent-First Business OS فارسی
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold leading-relaxed mb-4">
          کسب‌وکارت رو با <span className="text-[var(--primary)]">گفتگو</span> اداره کن، نه فرم.
        </h1>
        <p className="text-[var(--text-2)] mb-8 leading-8">
          به‌جای پر کردن فرم، فقط با Agent صحبت کن. مخاطب بساز، فاکتور صادر کن، ماژول اختصاصی بساز — همه با زبان طبیعی.
        </p>
        <div className="flex gap-3 justify-center">
          <Link href="/register" className="px-6 py-3 rounded-xl font-bold bg-[var(--primary)] text-[#1a1400]">
            شروع رایگان
          </Link>
          <Link href="/login" className="px-6 py-3 rounded-xl font-bold border border-[var(--border)] text-[var(--text-1)]">
            ورود به حساب
          </Link>
        </div>
      </section>

      <section className="px-6 pb-20">
        <div className="text-center mb-10">
          <h2 className="text-xl font-extrabold mb-2">پلن مناسب خودت رو انتخاب کن</h2>
          <p className="text-sm text-[var(--text-3)]">بدون نیاز به کارت اعتباری برای شروع — قیمت‌ها زنده از بک‌اند خونده می‌شن</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 max-w-5xl mx-auto">
          {(['free', 'starter', 'pro', 'enterprise'] as const).map((key) => {
            const p = byKey[key];
            const popular = key === 'pro';
            return (
              <div
                key={key}
                className={`rounded-2xl border p-5 flex flex-col ${
                  popular ? 'border-[var(--primary-dim)] bg-gradient-to-b from-[var(--primary-soft)] to-transparent' : 'border-[var(--border)] bg-[var(--surface)]'
                }`}
              >
                {popular && (
                  <div className="text-[10px] font-extrabold bg-[var(--primary)] text-[#1a1400] px-2.5 py-1 rounded-full w-fit mb-2">
                    محبوب‌ترین
                  </div>
                )}
                <div className="font-extrabold mb-1">{p?.name}</div>
                <div className="text-2xl font-extrabold mb-1">
                  {key === 'enterprise' ? (
                    <>
                      شروع از
                      <br />
                      <span className="text-lg">{toman(p?.priceYearlyToman ?? 0)}/سال</span>
                    </>
                  ) : (
                    toman(p?.priceMonthlyToman ?? 0) + (p?.priceMonthlyToman ? '/ماه' : '')
                  )}
                </div>
                <ul className="flex flex-col gap-2 text-xs text-[var(--text-2)] my-4 flex-1">
                  {FEATURE_ROWS[key].map((f) => (
                    <li key={f} className="flex gap-2">
                      <span className="text-[var(--success)]">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/register"
                  className={`text-center text-sm font-bold py-2.5 rounded-lg ${
                    popular ? 'bg-[var(--primary)] text-[#1a1400]' : 'border border-[var(--border)] text-[var(--text-1)]'
                  }`}
                >
                  {key === 'enterprise' ? 'تماس با فروش' : 'انتخاب پلن'}
                </Link>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
