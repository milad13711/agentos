# AgentOS Web — فرانت‌اند Production (Next.js)

## ⚠️ یک نکته صادقانه مهم قبل از هرچیز
این پروژه، برخلاف بک‌اند (`agentos-backend`)، **در همین محیط اجرا/build نشده** — چون این نشست به npm registry دسترسی نداره و نصب `next`/`react` ممکن نبود. کاری که واقعاً انجام دادم:

- تمام ۲۰ فایل TypeScript/TSX رو با **کامپایلر واقعی TypeScript** (نسخه نصب‌شده در همین محیط) از نظر **صحت نحوی (Syntax)** بررسی کردم — همه بدون خطا پاس شدن.
- تمام مسیرهای import (`@/lib/...`, `@/components/...`) رو با فایل‌های واقعی روی دیسک Cross-check کردم — همه درستن.
- ساختار App Router، امضای Route Handlerها، و الگوهای `'use client'`/Server Component رو مطابق مستندات رسمی Next.js 14 نوشتم.

چیزی که **نمی‌تونم** ادعا کنم: type-check کامل (چون `@types/react`/`next` نصب نیستن) یا اجرای واقعی `next build`. یعنی احتمال کمی وجود داره یک خطای type-level (نه syntax) بعد از `npm install` دیده بشه. اولین قدم بعد از دریافت این پروژه:

```bash
npm install
npm run build   # اگر خطایی بود، همینجا خودش رو نشون می‌ده
npm run dev
```

## معماری امنیتی — چرا این نسخه از `frontend-local` امن‌تره

در پروتوتایپ قبلی (`frontend-local/index.html`)، توکن AgentOS در `localStorage` مرورگر ذخیره می‌شد — یعنی هر اسکریپت شخص‌ثالث یا XSS می‌تونست بهش دسترسی پیدا کنه. در این نسخه:

1. مرورگر هیچ‌وقت توکن واقعی AgentOS رو نمی‌بینه.
2. `app/api/auth/login` و `register` سمت **سرور Next.js** با بک‌اند صحبت می‌کنن (server-to-server، بدون مشکل CORS)، توکن رو می‌گیرن، و در یک Cookie **httpOnly** (`agentos_session`) ذخیره می‌کنن.
3. برای هر درخواست دیگه، مرورگر به `/api/proxy/...` (روی همون دامنه Next.js) درخواست می‌ده؛ این Route Handler توکن رو از Cookie (سمت سرور) می‌خونه و به بک‌اند واقعی فوروارد می‌کنه.
4. کلید API هوش مصنوعی هم فقط سمت بک‌اند می‌مونه (همون‌طور که قبلاً بود) — این نسخه هیچ لایه امنیتی بک‌اند رو تغییر نمی‌ده، فقط نحوه نگهداری Session رو درست می‌کنه.

## ساختار پروژه

```
app/
  page.tsx                    → لندینگ + قیمت‌گذاری (Server Component، SSR، live از /api/plans بک‌اند)
  (auth)/login, register      → فرم‌های ورود/ثبت‌نام
  (app)/layout.tsx            → Auth Guard سمت سرور + سایدبار
  (app)/chat                  → گفتگو با Agent (تایید/رد، صدا، گزارش)
  (app)/tasks                 → وظایف/یادآور/ارجاع
  (app)/team                  → RBAC و مدیریت پرسنل
  (app)/settings              → شخصی‌سازی Agent
  (app)/reports               → دانلود Excel / چاپ PDF
  api/auth/{login,register,logout}/route.ts  → ست/پاک‌کردن Cookie
  api/proxy/[...path]/route.ts               → پروکسی احرازهویت‌شده به بک‌اند واقعی
lib/
  session.ts   → خواندن/نوشتن Cookie httpOnly
  backend.ts   → fetch wrapper سمت سرور با Bearer token از Cookie
components/
  ChatPanel.tsx, NavLink.tsx, LogoutButton.tsx
```

## اجرا در کنار بک‌اند واقعی

```bash
# ترمینال ۱ — بک‌اند
cd agentos-backend && node src/server.js

# ترمینال ۲ — فرانت‌اند
cd agentos-web
cp .env.local.example .env.local   # AGENTOS_API_URL=http://localhost:8787
npm install
npm run dev
```

بعد `http://localhost:3000` رو باز کن — لندینگ با قیمت‌های زنده از بک‌اند لود می‌شه.

## چیزی که در این پاس محدود شد (برای شدنی‌بودن)

- **چندزبانگی**: نسخه Next.js فعلاً فقط فارسی است؛ نسخه Artifact (`agentos-landing.html`) همون ۹ زبان رو داره. پورت‌کردن i18n به Next.js (با `next-intl` یا مشابه) یک قدم جداست.
- **Onboarding Wizard و شخصی‌سازی برند** (که در `agentos-landing.html` بود) هنوز پورت نشده — منطقش ساده‌ست، اولویت این پاس اتصال امن Auth + هسته Agent بود.
- Marketplace UI و Module Builder UI هنوز در Next.js پیاده نشدن (در `frontend-local/index.html` هستن) — همون الگوی proxy برای اضافه‌کردنشون کافیه.

## قدم بعدی طبیعی
بعد از `npm install && npm run build` و رفع هر خطای type-level احتمالی، فاز ۲ نقشه راه (Postgres + Docker + Deploy) روی همین پروژه اجرا می‌شه.
