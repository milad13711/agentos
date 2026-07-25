# AgentOS — پروژه Agent-First CRM فارسی

## برای session بعدی (خلاصه‌ی وضعیت)

همه‌چیز commit و push شده — برنچ فعلی `claude/continue-gk70lc` روی GitHub (`milad13711/agentos`) کاملاً به‌روزه، هیچ PR ای هنوز باز نشده (اگه لازم شد، صریح درخواست بده). ⚠️ توجه: workflow دیپلوی (`.github/workflows/deploy.yml`) هنوز فقط روی push به `claude/agentos-phase-0-1-setup-vcjcz8` تریگر می‌شه (گیر #۸ پایین) — یعنی push به این برنچ جدید *خودکار* دیپلوی نمی‌شه تا وقتی که کاربر صریحاً بخواد اون workflow آپدیت بشه یا این برنچ merge/rename بشه. قبل از هر کاری، `git log --oneline -20` و کل این فایل رو بخون تا context کامل باشه؛ سندهای تکمیلی: `docs/phase1-event-schema-agent-roles.md` (طراحی Event/dispatch) و `docs/ci-cd-setup.md`. لیست کامل کارهای انجام‌شده و باقی‌مونده دقیقاً همین‌جا پایین‌تره — چیز مهمی خارج از این فایل و خودِ کد نیست.

## معماری کلی

```
agentos-backend/   → عمدتاً Node.js خالص — node:http + node:crypto + (SQLite پیش‌فرض با node:sqlite، یا PostgreSQL واقعی وقتی DATABASE_URL ست بشه، با تنها dependency واقعی: `pg`)
agentos-web/        → Next.js 14 App Router — BFF pattern، توکن AgentOS فقط سمت سرور، httpOnly cookie
agentos-deploy/     → docker-compose.yml + Caddyfile + schema-postgres.sql (وایر شده، پایین رو ببین) + DEPLOY.md
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
7. این پروژه یک Git repository واقعی داره، روی GitHub (`milad13711/agentos`). هر تغییری باید commit و push بشه — دیگه کپی‌کردن zip/scp دستی نکن. (برنچ کاری قبلاً `claude/agentos-phase-0-1-setup-vcjcz8` بود، الان `claude/continue-gk70lc` — به گیر #۸ توجه کن، workflow دیپلوی هنوز روی برنچ قدیمی تریگر می‌شه.)
8. ✅ **دیگه دستی نیست** — `.github/workflows/deploy.yml` هر `git push` به برنچ `claude/agentos-phase-0-1-setup-vcjcz8` رو خودکار (بعد از یک build gate واقعی) رو سرور دیپلوی می‌کنه. جزئیات و راه‌اندازی اولیه در `docs/ci-cd-setup.md`. **این محیط Claude Code همچنان خودش SSH مستقیم نداره** (فقط پراکسی HTTP/HTTPS به میزبان‌های مجاز) — یعنی برای هر عملیات دستی خارج از CI/CD (مثل چک‌کردن لاگ زنده‌ی سرور)، دستورها رو باید *به کاربر* داد تا خودش رو سرور اجرا کنه.
9. Dockerfile بک‌اند فقط `src/` و `package.json` رو کپی می‌کرد — اگه فایل جدیدی مثل `scripts/` اضافه کردی، حتماً `COPY` مربوطه رو هم به Dockerfile اضافه کن، وگرنه توی کانتینر نیست حتی اگه توی ریپو باشه.
10. Next.js standalone output (در `agentos-web` Docker image) پیش‌فرض روی متغیر `HOSTNAME` بایند می‌شه که Docker خودکار به container ID ست می‌کنه — نه `0.0.0.0`. این باعث fail شدن HEALTHCHECK و هر تست `localhost` داخل کانتینر می‌شه. Dockerfile الان صریح `ENV HOSTNAME=0.0.0.0` داره؛ اگه یه‌بار دیگه container یهو unhealthy شد، همینو چک کن.
11. تماس‌های AI Gateway (`callAnthropic`/`callOpenAI` در `agent.js`) یک timeout ۲۵ ثانیه‌ای دارن (`AI_GATEWAY_TIMEOUT_MS`). قبلاً نداشتن و اگه GapGPT کند/بی‌پاسخ می‌شد، درخواست برای همیشه "در حال پردازش" می‌موند بدون هیچ خطایی تو لاگ.
12. تاریخچه‌ی چت (`ChatPanel.tsx`) تو `localStorage` مرورگر ذخیره می‌شه، با کلید per-user (`agentos_chat_messages:<userId>`) — قبلاً یک کلید ثابت بود که باعث می‌شد چت یک حساب تو حساب بعدی (روی همون مرورگر) دیده بشه. اگه فیچر مشابهی اضافه کردی، همیشه کلید `localStorage` رو namespace کن.
13. `docker compose up -d --build` کانتینر `caddy` رو ری‌استارت **نمی‌کنه** فقط چون محتوای `Caddyfile` (که volume-mount شده) عوض شده — Compose فقط وقتی سرویسی رو recreate می‌کنه که تعریف خودِ سرویس (image/env/...) عوض بشه. بعد از هر تغییر تو `Caddyfile`، صریحاً `docker compose restart caddy` بزن، وگرنه کانفیگ قدیمی تو حافظه می‌مونه (این دقیقاً چیزیه که موقع فعال‌سازی HTTPS واقعی گیر کردیم).
14. تو `agentos-web`، هیچ‌جا فقط `overflow-y-auto` تنها نذار — طبق اسپک CSS، اگه overflow-x رو صریح ست نکنی، مرورگر خودش overflow-x رو هم `auto` می‌کنه (نه `hidden`)، یعنی همون کانتینر می‌تونه جدا اسکرول افقی بگیره. این با موس رو دسکتاپ اصلاً حس نمی‌شه ولی رو گوشی با لمس خیلی اذیت‌کننده‌ست. همیشه `overflow-y-auto overflow-x-hidden` با هم بنویس (همه‌ی صفحات `(app)` الان همینطورن).
15. `src/db.js` الان دو تا backend داره پشت یک API یکسان (`db.get/all/run/exec`, همه async، placeholder همیشه `?`) — هرگز مستقیم `db.prepare(...)` یا SQL مخصوص یک backend ننویس. دو گیر واقعی که فقط با Postgres واقعی (نه فقط خوندن کد) کشف شدن:
    - ستون‌های JSON (`fields_json`, `values_json`, `features_json`, `payload_json`) عمداً `TEXT` نگه داشته شدن، نه `JSONB` — چون `pg` ستون‌های JSONB رو خودکار به Object پارس می‌کنه، ولی همه‌جای کد `JSON.parse(row.xxx_json)` صدا می‌زنه (چون SQLite همیشه TEXT خام برمی‌گردونه). اگه یه ستون JSON جدید اضافه کردی، تو schema پستگرس هم `TEXT` بذار، نه `JSONB`.
    - ستون‌های `BIGINT` (تایم‌استمپ میلی‌ثانیه‌ای) از `pg` به‌صورت **string** برمی‌گردن، نه Number — `db.js` با `pg.types.setTypeParser(20, ...)` این رو به Number تبدیل می‌کنه (چون فرانت جاهایی مثل `new Date(row.created_at)` عدد می‌خواد، و روی string غیر-ISO نتیجه `Invalid Date` می‌ده). اگه یه ستون BIGINT جدید اضافه کردی، همین رفتار خودکار شامل حالش می‌شه؛ فقط یادت باشه چرا اون خط تو db.js هست.
    - همچنین: مقایسه‌ی لفظی ستون‌های Boolean-مانند (`enabled`, `is_active`, `is_super_admin`) تو SQL همیشه با `= TRUE`/`= FALSE` بنویس، نه `= 1`/`= 0` — تو Postgres این ستون‌ها واقعاً `BOOLEAN`ن و `col = 1` خطای type می‌ده (ولی پارامتر bind‌شده با مقدار JS عدد ۰/۱ مشکلی نداره، چون Postgres رشته‌ی `'0'`/`'1'` رو boolean معتبر می‌دونه — فقط literal تو خودِ متن SQL مشکل‌سازه).

## پلن‌ها

(تومان، منبع حقیقت: جدول `plans` در دیتابیس، نه کد هاردکد)
Free (۰) → Starter (۹۹۰هزار/ماه) → Pro (۲.۹۹۹میلیون/ماه، محبوب‌ترین) → Enterprise (شروع از ۹.۹میلیون/ماه، سقف سالانه ۹۹میلیون)

## فازهای باقی‌مانده (اولویت‌بندی‌شده)

1. ✅ ~~رفع بدهی فنی create_contact/create_deal~~ — فاز ۱ کامل شد و روی production تأیید شد. جزئیات کامل (schema، تصمیم‌ها، نتیجه دیپلوی) در `docs/phase1-event-schema-agent-roles.md`.
2. ✅ ~~HTTPS واقعی~~ — DNS جا افتاد، Caddy گواهی Let's Encrypt گرفت، `ALLOW_INSECURE_COOKIE` حذف شد
3. ✅ ~~راه‌اندازی CI/CD ساده~~ — `.github/workflows/deploy.yml` (build gate + دیپلوی خودکار SSH). راهنمای setup در `docs/ci-cd-setup.md`
4. ✅ ~~Marketplace UI در Next.js~~ — صفحه `/marketplace` اضافه شد (انتشار ماژول خودت + نصب از کاتالوگ مشترک)، بک‌اندش از قبل آماده بود
5. ✅ ~~مهاجرت PostgreSQL~~ — `src/db.js` الان از هر دو backend پشتیبانی می‌کنه (SQLite پیش‌فرض، Postgres وقتی `DATABASE_URL` ست بشه)، با یک PostgreSQL 16 واقعی تست شد (نه شبیه‌سازی) — کل تست‌suite بک‌اند + یک اجرای دستی end-to-end. جزئیات، دو باگ واقعی که فقط با تست روی Postgres واقعی پیدا شدن (JSONB auto-parse، BIGINT-as-string)، و راهنمای فعال‌سازی در `agentos-deploy/DEPLOY.md`. **هنوز واقعاً روی SQLite در production هستیم** — این کار فقط زیرساخت رو آماده کرد؛ فعال‌سازی واقعی Postgres روی سرور یک تصمیم جداست (وقتی واقعاً به چند Instance نیاز شد). RLS (`schema-postgres.sql`) هم مستنده ولی عمداً هنوز وایر نشده — به همون فایل مراجعه کن.
6. Zarinpal واقعی — **عمداً به تعویق افتاد**: دامنه فعلی (`exirsms.ir`) فقط تستیه، برای پروژه نهایی نیست؛ گرفتن Merchant ID روی این دامنه بعداً موقع مهاجرت به دامنه اصلی دردسر می‌سازه. وقتی دامنه نهایی مشخص شد، اول اون رو ست کن، بعد Zarinpal.
7. ✅ ~~تأخیر ۱۲ساعته‌ی اعمال تغییر نقش/دسترسی~~ — بدون نیاز به زیرساخت کامل Refresh Token: `requireAuth()`/`requireSuperAdmin()` تو `server.js` الان `role` و `is_super_admin` رو هم (مثل `status`) هر بار مستقیم از DB می‌خونن، نه از claim توکن. یعنی تغییر نقش یا ارتقا/تنزل super-admin از همون درخواست بعدی روی توکن قبلاً صادرشده اعمال می‌شه، بدون re-login. جزئیات در «کارهای اضافه‌ای» پایین. (Refresh Token/Revocation List واقعی هنوز نیست — اگه یه‌جا نیاز به logout فوری همه‌ی نشست‌های یک کاربر یا invalidate کردن یک توکن مشخص قبل از expire شدنش پیش اومد، هنوز باید اضافه بشه؛ ولی گپ اصلی که تو این پروژه شناسایی شده بود بسته شد.)

## کارهای اضافه‌ای که خارج از این لیست انجام شد (ولی مهم بودن)

- ✅ تست‌های خودکار بک‌اند (`agentos-backend/test/`, با `node:test` بدون dependency جدید) برای `dispatch`/Approval Gate/ایزوله‌بودن Tenant — به CI (`npm test` در `build-check`) وصل شدن، چون این‌ها دقیقاً چیزهاییه که فاز ۱ رو migrate کردیم و فقط با curl دستی تست شده بودن.
- ✅ Super Admin Dashboard در Next.js (`/admin`) — قبلاً فقط تو `frontend-local/admin.html` (HTML خام) بود. همه‌ی ۵ تب (KPI، Tenantها، پلن‌ها، Marketplace، Audit Log) رو داره؛ بک‌اندش تغییری نکرد.
- ✅ کل UI موبایل/ریسپانسیو شد: منوی sidebar روی موبایل به drawer قابل‌باز/بسته تبدیل شد (`components/AppShell.tsx`)، همه‌ی جدول‌ها به‌جای شکستن layout خودشون جدا اسکرول افقی می‌گیرن، و باگ واقعی `overflow-y-auto` (گیر #۱۴ بالا) که فقط رو گوشی با لمس قابل کشف بود پیدا و فیکس شد.
- ✅ یک بازبینی امنیتی کامل انجام شد (auth، ایزوله‌بودن Tenant، کدهای جدید فاز ۱/Admin/Marketplace). ۴ مورد واقعی پیدا و فیکس شد:
  - XSS ذخیره‌شده تو تولید PDF گزارش (`reports/page.tsx`) — اسم مخاطب/معامله بدون escape تو HTML تزریق می‌شد؛ با DOM API امن (`textContent`) بازنویسی شد.
  - حذف/غیرفعال‌کردن پرسنل واقعاً دسترسی رو لغو نمی‌کرد — توکن قدیمی تا ۱۲ ساعت کار می‌کرد و حتی می‌شد دوباره لاگین کرد؛ الان `requireAuth()` و `/api/auth/login` وضعیت زنده‌ی `users.status` رو چک می‌کنن.
  - تزریق فرمول تو خروجی CSV/Excel گزارش‌ها (مثل اسم مخاطب `=cmd|...`) — با prefix کردن `'` (استاندارد OWASP) خنثی شد، هم تو CSV هم تو `.xlsx` واقعی.
  - یک رگرسیون واقعی از فاز ۱: `billing.js` هنوز تو جدول حذف‌شده‌ی `audit_logs` می‌نوشت (تایید پرداخت واقعی زرین‌پال رو crash می‌کرد) — به `audit()` استاندارد (که رو `events` می‌نویسه) منتقل شد.
  - ✅ **رفع شد (بعد از بازبینی امنیتی اولیه)**: تغییر نقش کاربر (مثلاً admin→member یا برعکس) و ارتقا/تنزل super-admin دیگه منتظر expire شدن توکن (تا ۱۲ ساعت) نمی‌مونن. `requireAuth()` و `requireSuperAdmin()` تو `agentos-backend/src/server.js` حالا `role`/`is_super_admin` رو از ردیف زنده‌ی `users` می‌خونن (دقیقاً مثل کاری که قبلاً برای `status` انجام شده بود)، نه از payload امضاشده‌ی توکن. تست integration واقعی (نه mock) این رفتار رو قفل کرده: `agentos-backend/test/auth-staleness.test.js` — یک توکن قدیمی رو می‌گیره، نقش کاربر رو از سمت owner عوض می‌کنه، و چک می‌کنه که همون توکن قدیمی (بدون re-login) بلافاصله نقش جدید رو منعکس کنه؛ تست دوم مشابه برای حذف عضو تیم. برای اجرای این ری‌فکتور کوچیک، `server.listen()` تو `server.js` پشت `if (require.main === module)` قرار گرفت تا require کردن ماژول تو تست بدون بایند کردن یک پورت واقعی کار کنه (رفتار اجرای مستقیم `node src/server.js` تغییری نکرده).
