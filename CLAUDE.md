# AgentOS — پروژه Agent-First CRM فارسی

## معماری کلی

```
agentos-backend/   → Node.js خالص (بدون dependency!) — node:http + node:sqlite + node:crypto
agentos-web/        → Next.js 14 App Router — BFF pattern، توکن AgentOS فقط سمت سرور، httpOnly cookie
agentos-deploy/     → docker-compose.yml + Caddyfile + schema-postgres.sql (مرجع، هنوز وایر نشده) + DEPLOY.md
frontend-local/     → (داخل agentos-backend) دو HTML مستقل بدون build، برای تست سریع بدون Next.js
```

## دستورات مهم

```bash
# بک‌اند (لوکال)
cd agentos-backend && node src/server.js

# فرانت (لوکال)
cd agentos-web && npm run dev

# دیپلوی کامل (روی سرور)
docker compose up -d --build
docker compose logs -f
docker compose exec backend node -e "..."   # اجرای اسکریپت مستقیم روی دیتابیس زنده

# ریست کامل دیتابیس محلی
rm -rf agentos-backend/data
```

## وضعیت استقرار فعلی

* سرور: `94.182.93.52` (Ubuntu 22.04، Hetzner/مشابه)، SSH: `root@94.182.93.52`
* فایل‌ها روی سرور: `~/agentos-backend`, `~/agentos-web`, `~/docker-compose.yml`, `~/Caddyfile`, `~/.env`
* دامنه: `exirsms.ir` — ✅ کامل جا افتاده (Cloudflare Name Server از طریق پنل IRNIC، رکورد A به‌صورت DNS-only/ابر خاکستری تا Let's Encrypt مستقیم بتونه challenge رو حل کنه)
* ✅ **HTTPS واقعی فعاله** — Caddy با `Caddyfile` روی `exirsms.ir, www.exirsms.ir` گواهی Let's Encrypt گرفته (auto-renew)، ریدایرکت خودکار HTTP→HTTPS (308) کار می‌کنه. `ALLOW_INSECURE_COOKIE` از `docker-compose.yml` حذف شد؛ کوکی نشست الان `Secure` واقعیه.
* AI Gateway: GapGPT (پروکسی ایرانی سازگار با OpenAI API) با مدل `gapgpt-qwen-3.5`، `OPENAI_BASE_URL=https://api.gapgpt.app/v1`
* Zarinpal: در حالت Sandbox (`ZARINPAL_SANDBOX=1`)، هنوز Merchant ID واقعی نداره

## گیرهای مهم (وقت زیادی صرف کشفشون شد — دوباره بهشون گیر نکن)

1. `env-loader.js` اولین مقدار رو نگه می‌داره، نه آخری — اگه یک متغیر توی `.env` دوبار تعریف بشه، خط اول برنده‌ست. همیشه بعد از ویرایش `.env`، با `grep -c "^KEY="` چک کن که هر متغیر دقیقاً یک‌بار باشه.
2. Next.js Dockerfile نیاز به پوشه `public/` داره (`COPY --from=builder /app/public ./public`) — اگه این پوشه نباشه build fail می‌شه. یک `public/robots.txt` نمونه از قبل توی پروژه هست، حذفش نکن.
3. کوکی نشست (`lib/session.ts`) با `secure: NODE_ENV==='production'` — روی HTTP خام (بدون TLS)، این باعث می‌شه مرورگر کوکی رو اصلاً ذخیره نکنه (لاگین "بی‌صدا" fail می‌شه). ✅ دیگه موضوعیت نداره چون HTTPS واقعی فعاله؛ اگه یه سرور/محیط جدید دوباره روی HTTP خام تست می‌کنید، یادتون باشه `ALLOW_INSECURE_COOKIE=1` موقتاً لازمه.
4. بک‌اند در `docker-compose.yml` به بیرون expose نمی‌شه (عمداً — کلید AI هیچ‌وقت نباید در معرض شبکه باشه). فقط از طریق شبکه داخلی Docker با `web` صحبت می‌کنه. اگه خواستی مستقیم تستش کنی: `docker compose exec web wget -qO- http://backend:8787/api/health`
5. ✅ **رفع شد (فاز ۱)**: منطق `create_contact`/`create_deal` و بقیه اکشن‌های نویسا دیگه دوبار پیاده‌سازی نشده — یک `dispatch()` واحد در `agentos-backend/src/actions.js` که هم `server.js` هم `agent.js` صداش می‌زنن. جزئیات کامل در `docs/phase1-event-schema-agent-roles.md`.
6. Node 22 لازمه (نه کمتر) — چون از `node:sqlite` استفاده می‌کنیم که Native و بدون هیچ dependency خارجیه.
7. این پروژه یک Git repository واقعی داره، روی GitHub (`milad13711/agentos`، برنچ فعلی `claude/agentos-phase-0-1-setup-vcjcz8`). هر تغییری باید commit و push بشه — دیگه کپی‌کردن zip/scp دستی نکن.
8. **دیپلوی روی سرور فعلاً کاملاً دستی‌ست** (بند ۳ فازهای باقی‌مونده، هنوز CI/CD نداریم): SSH به سرور، `cd ~/agentos-src && git pull ...`، `rsync` به `~/agentos-backend`/`~/agentos-web`، بعد `docker compose up -d --build`. این محیط Claude Code خودش SSH نداره (فقط پراکسی HTTP/HTTPS به میزبان‌های مجاز) — یعنی دستورهای دیپلوی رو باید *به کاربر* داد تا خودش رو سرور اجرا کنه، نه اینکه فرض بشه مستقیم قابل‌اجراست.
9. Dockerfile بک‌اند فقط `src/` و `package.json` رو کپی می‌کرد — اگه فایل جدیدی مثل `scripts/` اضافه کردی، حتماً `COPY` مربوطه رو هم به Dockerfile اضافه کن، وگرنه توی کانتینر نیست حتی اگه توی ریپو باشه.
10. Next.js standalone output (در `agentos-web` Docker image) پیش‌فرض روی متغیر `HOSTNAME` بایند می‌شه که Docker خودکار به container ID ست می‌کنه — نه `0.0.0.0`. این باعث fail شدن HEALTHCHECK و هر تست `localhost` داخل کانتینر می‌شه. Dockerfile الان صریح `ENV HOSTNAME=0.0.0.0` داره؛ اگه یه‌بار دیگه container یهو unhealthy شد، همینو چک کن.
11. تماس‌های AI Gateway (`callAnthropic`/`callOpenAI` در `agent.js`) یک timeout ۲۵ ثانیه‌ای دارن (`AI_GATEWAY_TIMEOUT_MS`). قبلاً نداشتن و اگه GapGPT کند/بی‌پاسخ می‌شد، درخواست برای همیشه "در حال پردازش" می‌موند بدون هیچ خطایی تو لاگ.
12. تاریخچه‌ی چت (`ChatPanel.tsx`) تو `localStorage` مرورگر ذخیره می‌شه، با کلید per-user (`agentos_chat_messages:<userId>`) — قبلاً یک کلید ثابت بود که باعث می‌شد چت یک حساب تو حساب بعدی (روی همون مرورگر) دیده بشه. اگه فیچر مشابهی اضافه کردی، همیشه کلید `localStorage` رو namespace کن.
13. `docker compose up -d --build` کانتینر `caddy` رو ری‌استارت **نمی‌کنه** فقط چون محتوای `Caddyfile` (که volume-mount شده) عوض شده — Compose فقط وقتی سرویسی رو recreate می‌کنه که تعریف خودِ سرویس (image/env/...) عوض بشه. بعد از هر تغییر تو `Caddyfile`، صریحاً `docker compose restart caddy` بزن، وگرنه کانفیگ قدیمی تو حافظه می‌مونه (این دقیقاً چیزیه که موقع فعال‌سازی HTTPS واقعی گیر کردیم).
14. تو `agentos-web`، هیچ‌جا فقط `overflow-y-auto` تنها نذار — طبق اسپک CSS، اگه overflow-x رو صریح ست نکنی، مرورگر خودش overflow-x رو هم `auto` می‌کنه (نه `hidden`)، یعنی همون کانتینر می‌تونه جدا اسکرول افقی بگیره. این با موس رو دسکتاپ اصلاً حس نمی‌شه ولی رو گوشی با لمس خیلی اذیت‌کننده‌ست. همیشه `overflow-y-auto overflow-x-hidden` با هم بنویس (همه‌ی صفحات `(app)` الان همینطورن).

## پلن‌ها

(تومان، منبع حقیقت: جدول `plans` در دیتابیس، نه کد هاردکد)
Free (۰) → Starter (۹۹۰هزار/ماه) → Pro (۲.۹۹۹میلیون/ماه، محبوب‌ترین) → Enterprise (شروع از ۹.۹میلیون/ماه، سقف سالانه ۹۹میلیون)

## فازهای باقی‌مانده (اولویت‌بندی‌شده)

1. ✅ ~~رفع بدهی فنی create_contact/create_deal~~ — فاز ۱ کامل شد و روی production تأیید شد. جزئیات کامل (schema، تصمیم‌ها، نتیجه دیپلوی) در `docs/phase1-event-schema-agent-roles.md`.
2. ✅ ~~HTTPS واقعی~~ — DNS جا افتاد، Caddy گواهی Let's Encrypt گرفت، `ALLOW_INSECURE_COOKIE` حذف شد
3. ✅ ~~راه‌اندازی CI/CD ساده~~ — `.github/workflows/deploy.yml` (build gate + دیپلوی خودکار SSH). راهنمای setup در `docs/ci-cd-setup.md`
4. ✅ ~~Marketplace UI در Next.js~~ — صفحه `/marketplace` اضافه شد (انتشار ماژول خودت + نصب از کاتالوگ مشترک)، بک‌اندش از قبل آماده بود
5. مهاجرت PostgreSQL (فقط وقتی واقعاً به چند Instance نیاز شد — `schema-postgres.sql` آماده‌ست ولی وایر نشده؛ چک‌لیست کامل در `agentos-deploy/DEPLOY.md`)
6. Zarinpal واقعی — **عمداً به تعویق افتاد**: دامنه فعلی (`exirsms.ir`) فقط تستیه، برای پروژه نهایی نیست؛ گرفتن Merchant ID روی این دامنه بعداً موقع مهاجرت به دامنه اصلی دردسر می‌سازه. وقتی دامنه نهایی مشخص شد، اول اون رو ست کن، بعد Zarinpal.

## کارهای اضافه‌ای که خارج از این لیست انجام شد (ولی مهم بودن)

- ✅ تست‌های خودکار بک‌اند (`agentos-backend/test/`, با `node:test` بدون dependency جدید) برای `dispatch`/Approval Gate/ایزوله‌بودن Tenant — به CI (`npm test` در `build-check`) وصل شدن، چون این‌ها دقیقاً چیزهاییه که فاز ۱ رو migrate کردیم و فقط با curl دستی تست شده بودن.
- ✅ Super Admin Dashboard در Next.js (`/admin`) — قبلاً فقط تو `frontend-local/admin.html` (HTML خام) بود. همه‌ی ۵ تب (KPI، Tenantها، پلن‌ها، Marketplace، Audit Log) رو داره؛ بک‌اندش تغییری نکرد.
- ✅ کل UI موبایل/ریسپانسیو شد: منوی sidebar روی موبایل به drawer قابل‌باز/بسته تبدیل شد (`components/AppShell.tsx`)، همه‌ی جدول‌ها به‌جای شکستن layout خودشون جدا اسکرول افقی می‌گیرن، و باگ واقعی `overflow-y-auto` (گیر #۱۴ بالا) که فقط رو گوشی با لمس قابل کشف بود پیدا و فیکس شد.
