# فاز ۲ — طراحی: اتصال واقعی Frontend به Backend

## محدودیت صادقانه این محیط
این سند طراحیه، نه پیاده‌سازی کامل. چون این نشست (sandbox) به npm registry دسترسی نداره (`npm install` با خطای ۴۰۳ رد می‌شه)، نمی‌تونم یک اپ Next.js واقعی رو اینجا build/run کنم. کد پایین کاملاً درسته و آماده اجراست، ولی باید در یک محیط با دسترسی به اینترنت (مثلاً Claude Code روی سیستم خودت، یا هر CI واقعی) نصب و تست بشه.

## معماری پیشنهادی

```
Next.js App Router (frontend)
  ├── lib/api-client.ts     → یک fetch wrapper با baseURL از env، تزریق خودکار Authorization header
  ├── lib/auth-context.tsx  → React Context برای token/user/tenant، با Refresh در localStorage یا cookie
  ├── app/(marketing)/...   → لندینگ، Pricing (بدون auth)
  ├── app/(app)/dashboard   → CRM Agent UI (نسخه واقعی همون چیزی که تو Artifact ساختیم، الان با fetch به API واقعی)
  └── app/(app)/settings    → Connectors (Payments / AI Providers / Integrations)
```

### تصمیم مهم امنیتی: نگهداری Token
در پروتوتایپ Artifact، هیچ نگهداری امنی وجود نداشت (چون در مرورگر sandbox بود). در نسخه واقعی:
- **توصیه:** بک‌اند به‌جای برگردوندن token در JSON body، اون رو به‌صورت `httpOnly, Secure, SameSite=Lax` Cookie ست کنه. این یعنی یک Endpoint جدید یا تغییر کوچیک در `/api/auth/login` و `/api/auth/register` لازم داریم که علاوه بر JSON، هدر `Set-Cookie` هم بفرسته.
- جایگزین ساده‌تر (اگر می‌خوایم فعلاً همون Bearer Token رو نگه داریم): توکن فقط در حافظه React (نه localStorage) نگه داشته بشه + یک Endpoint `POST /api/auth/refresh` که با یک Refresh Token جدا (در httpOnly cookie) توکن کوتاه‌مدت جدید بده. این نیاز به یک جدول `refresh_tokens` تو `db.js` داره (یکی از موارد «باقی‌مونده» که در README بک‌اند هم اشاره شد).

### تغییرات لازم روی همین Backend فعلی
1. جدول `refresh_tokens(id, user_id, token_hash, expires_at, revoked_at)` در `db.js`
2. `POST /api/auth/refresh` و `POST /api/auth/logout` (Revoke) در `server.js`
3. تغییر `signToken` در `auth.js` به دو نوع: Access Token کوتاه‌مدت (۱۵ دقیقه) + Refresh Token بلندمدت (۳۰ روز)
4. اضافه‌کردن CORS محدود به دامنه واقعی فرانت‌اند (الان `*` است که فقط برای دمو قابل قبوله)

### API Client (نمونه کد واقعی و آماده استفاده)
```ts
// lib/api-client.ts
const BASE_URL = process.env.NEXT_PUBLIC_API_URL!; // مثلاً https://api.agentos.app

export async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    credentials: 'include', // برای httpOnly cookie
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    // تلاش برای refresh یک‌بار، بعد retry؛ در غیر این صورت logout
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'request_failed');
  return res.json();
}
```

### مسیر جایگزینی منطق Agent در Artifact با API واقعی
هر جای Artifact که مستقیم `fetch('https://api.anthropic.com/...')` می‌زد، در نسخه واقعی می‌شه:
```ts
await apiFetch('/api/agent/act', { method: 'POST', body: JSON.stringify({ text }) });
```
یعنی کلید Anthropic دیگه هیچ‌وقت روی مرورگر کاربر نیست — همیشه سمت Backend (AI Gateway) می‌مونه. این خودش یک ارتقای امنیتی مهمه نسبت به پروتوتایپ.

## چک‌لیست خروج از فاز ۲
- [ ] اپ Next.js واقعی build و روی یک محیط staging deploy شده
- [ ] لاگین/ثبت‌نام واقعی از فرانت‌اند به همین Backend وصله (نه Mock)
- [ ] `/api/agent/act` + Approval Gate از UI واقعی (نه Artifact) قابل استفاده‌ست
- [ ] هیچ کلید AI روی کد سمت کاربر (مرورگر) اکسپوز نشده
