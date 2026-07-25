# AgentOS — راهنمای استقرار (Deploy)

## ⚠️ صادقانه بگم قبل از هرچیز
Docker و PostgreSQL توی همین محیطی که این فایل‌ها رو نوشتم وجود نداشتن — یعنی نتونستم مثل بک‌اند (که واقعاً روی سرور اجرا و با curl تست شد) این Dockerfileها/Composeها رو واقعاً build/run کنم. کاری که واقعاً انجام دادم:
- `docker-compose.yml` رو با پایتون (`yaml.safe_load`) از نظر ساختار YAML معتبر بودن تست کردم ✅
- `schema-postgres.sql` رو از نظر تعادل پرانتز/کوتیشن بررسی کردم ✅
- Dockerfileها رو دقیقاً مطابق الگوی استاندارد و مستندشده Next.js (`output: 'standalone'`) و Node نوشتم

اولین قدم شما باید `docker compose up -d --build` روی یک سیستم واقعی (مک‌بوک خودتون یا سرور) باشه — اگه خطایی داد، دقیق برام بفرستش.

## ساختار فایل‌ها

```
agent-os-project/
  agentos-backend/       (Dockerfile داخلشه)
  agentos-web/            (Dockerfile داخلشه)
  docker-compose.yml       ← این و بقیه رو از این پکیج بردار و اینجا بذار
  Caddyfile
  .env                      ← از .env.example بساز
```

## اجرای محلی (تست روی همون مک‌بوک، قبل از رفتن به سرور واقعی)

نیاز به نصب Docker Desktop داری (اگه نداری): https://www.docker.com/products/docker-desktop

```bash
cd ~/Documents/agent-os-project
# فایل‌های این پکیج (docker-compose.yml, Caddyfile, .env.example, schema-postgres.sql) رو اینجا کپی کن
cp .env.example .env
nano .env   # مقادیر واقعی (AGENTOS_TOKEN_SECRET, کلید AI و...) رو پر کن

# برای تست محلی، Caddyfile رو موقتاً به حالت بدون دامنه عوض کن:
# (خط your-domain.com رو کامنت کن، خط :80 رو فعال کن)

docker compose up -d --build
docker compose logs -f
```

بعد `http://localhost` (نه localhost:3000 — این‌بار از طریق Caddy روی پورت ۸۰) رو باز کن.

## استقرار روی سرور واقعی (VPS)

۱. یک VPS بگیر (هر ارائه‌دهنده‌ای — فقط باید Docker نصب بشه، حداقل ۱GB RAM کافیه برای شروع)
۲. دامنه‌ت رو به IP سرور اشاره بده (رکورد A در DNS)
۳. روی سرور:
```bash
# نصب Docker (روی اوبونتو/دبیان)
curl -fsSL https://get.docker.com | sh

git clone <یا فایل‌ها رو scp کن>
cd agent-os-project
cp .env.example .env
nano .env   # مقادیر واقعی رو پر کن، AGENTOS_TOKEN_SECRET رو حتماً یک رشته تصادفی جدی بذار

nano Caddyfile   # your-domain.com رو با دامنه واقعیت عوض کن

docker compose up -d --build
```
Caddy خودکار گواهی TLS واقعی (Let's Encrypt) می‌گیره — نیازی به کار دستی نیست.

۴. تست: `https://your-domain.com`

## پشتیبان‌گیری از داده (مهم!)

داده واقعی کسب‌وکارت الان توی یک فایل SQLite داخل Volume داکره:
```bash
# پشتیبان‌گیری دستی
docker compose exec backend cp /app/data/agentos.sqlite /app/data/backup-$(date +%Y%m%d).sqlite
docker cp $(docker compose ps -q backend):/app/data/backup-$(date +%Y%m%d).sqlite ./backups/
```
پیشنهاد می‌کنم این رو یک Cron Job روزانه بکنی. برای Production واقعی، ابزاری مثل [Litestream](https://litestream.io) رو در نظر بگیر که SQLite رو به‌صورت پیوسته به S3/مشابه پشتیبان می‌گیره.

## درگاه پرداخت واقعی (زرین‌پال)

اضافه شد و **واقعاً تست شد** (با API جعلی شبیه‌سازی‌شده — نه شبکه واقعی، ولی منطق کامل چرخه پرداخت: درخواست → عدم‌تغییر پلن قبل از تایید → verify → تغییر پلن → idempotency در تایید دوباره، همه با تست تایید شد).

### گرفتن Merchant ID
برو به https://next.zarinpal.com، ثبت‌نام کن، یک درگاه بساز، Merchant ID رو کپی کن.

### تنظیم روی سرور
به `.env` این‌ها رو اضافه کن:
```
ZARINPAL_MERCHANT_ID=merchant-id-واقعی-یا-تستی-ت
ZARINPAL_SANDBOX=1
PUBLIC_APP_URL=https://exirsms.ir
```
- `ZARINPAL_SANDBOX=1` یعنی حالت تست (پرداخت واقعی انجام نمی‌شه، برای تست چرخه کامل بدون نیاز به تایید حساب زرین‌پال). وقتی حساب واقعی تایید شد، این رو `0` کن.
- `PUBLIC_APP_URL` باید دقیقاً همون آدرسی باشه که کاربر توی مرورگرش می‌بینه (چون زرین‌پال بعد از پرداخت، مرورگر کاربر رو به همین آدرس + `/api/billing/callback` برمی‌گردونه).

### بازسازی
```bash
docker compose up -d --build backend
```

### تست
وارد `/billing` بشو، روی یکی از دکمه‌های ارتقا بزن — باید به صفحه پرداخت زرین‌پال (Sandbox) هدایت بشی.


## مهاجرت PostgreSQL (وایر شده و تست شده — فقط وقتی لازمش داری فعالش کن)

✅ **دیگه فقط طرح نیست** — `src/db.js` الان واقعاً از هر دو backend پشتیبانی می‌کنه (SQLite پیش‌فرض، PostgreSQL وقتی `DATABASE_URL` ست بشه)، با یک API یکسان (`db.get/all/run/exec`, همه async) که همه‌جای کد (`actions.js`, `agent.js`, `billing.js`, `server.js`) ازش استفاده می‌کنن — دیگه هیچ‌جا مستقیم SQL backend-specific نداریم. این رو با یک PostgreSQL 16 واقعی (نه شبیه‌سازی) تست کردم: کل تست‌suite بک‌اند (۱۳ تست) هم روی SQLite هم روی Postgres سبز می‌شه، و یک اجرای دستی end-to-end (ثبت‌نام، ساخت مخاطب/معامله/ماژول/رکورد، Marketplace، چت Agent، گزارش CSV) هم روی Postgres واقعی چک شد.

دو باگ واقعی که فقط با تست روی Postgres واقعی پیدا می‌شدن (نه با خوندن کد):
- ستون‌های JSON (`fields_json`, `values_json`, `features_json`, `payload_json`) اگه `JSONB` باشن، درایور `pg` خودکار parse‌شون می‌کنه به Object — ولی کد همه‌جا `JSON.parse(row.fields_json)` صدا می‌زنه چون SQLite این‌ها رو به‌صورت TEXT خام برمی‌گردونه. راه‌حل: این ستون‌ها تو schema پستگرس هم `TEXT` نگه داشته شدن (نه JSONB) تا رفتار دو backend دقیقاً یکی باشه.
- ستون‌های `BIGINT` (تایم‌استمپ‌های `Date.now()`) از `pg` به‌صورت string برمی‌گردن (چون BIGINT می‌تونه از safe-integer جاوااسکریپت رد بشه) — ولی SQLite و کل فرانت (مثلاً `new Date(row.created_at)`) عدد می‌خوان. راه‌حل: `pg.types.setTypeParser(20, ...)` تو `db.js` این‌ها رو به Number تبدیل می‌کنه (امن، چون تایم‌استمپ‌های ما میلی‌ثانیه‌ای هستن، خیلی کمتر از سقف safe-integer).

### فعال‌سازی (فقط وقتی واقعاً به چند Instance نیاز داری)

۱. تو `docker-compose.yml`، سرویس `postgres` (کامنت‌شده، پایین فایل) رو از کامنت دربیار، و `backend.depends_on: [postgres]` رو هم.
۲. تو `.env`: `POSTGRES_PASSWORD` و `DATABASE_URL=postgres://agentos:<همون پسورد>@postgres:5432/agentos` رو ست کن.
۳. `docker compose up -d --build` — `src/db.js` خودش جدول‌ها رو می‌سازه (idempotent، هر بار boot دوباره امن اجرا می‌شه).
۴. اگه داده واقعی تو SQLite قبلی داری، یک‌بار مهاجرتش کن:
   ```bash
   docker compose exec backend sh -c "AGENTOS_DB_PATH=/app/data/agentos.sqlite DATABASE_URL=\$DATABASE_URL node scripts/migrate-sqlite-to-postgres.js"
   ```
   این اسکریپت **مخرب روی مقصده** (جدول‌های Postgres رو قبل از کپی خالی می‌کنه) — فقط رو یک دیتابیس Postgres تازه/تست‌شده اجراش کن، نه رو چیزی که همین الان ترافیک زنده داره.
۵. تست کن (لاگین، ساخت مخاطب/معامله، چک `docker compose logs backend` که خطای اتصال نده).

### Row-Level Security — هنوز وایر نشده (عمداً)

`schema-postgres.sql` علاوه بر جدول‌ها، Policy های RLS هم مستند می‌کنه (دفاع لایه‌ی دیتابیس در برابر باگ‌های فراموش‌کردن `WHERE tenant_id = ?`). اون Policy ها **در کد فعلی وایر نشدن** — فعال‌کردنشون بدون تغییر اپلیکیشن، اپ رو می‌شکنه (مثلاً لاگین با ایمیل ذاتاً باید cross-tenant باشه قبل از اینکه tenant مشخص بشه، ولی RLS پیش‌فرض همه‌چی رو تا وقتی `SET LOCAL app.current_tenant_id` ست نشده رد می‌کنه). فعال‌سازی واقعی RLS نیاز داره هر درخواست HTTP یک اتصال اختصاصی از pool بگیره (نه query تصادفی روی هر کانکشن آزاد pool)، این متغیر session رو موقع شروع درخواست ست کنه، و مسیرهای قبل از احراز هویت (لاگین/ثبت‌نام) رو جدا طراحی کنه. این یک تغییر معماری جداست، نه بخشی از این مهاجرت — تا وقتی لازمش نشده، ایزوله‌بودن Tenant همون‌جوری که الان هست (فیلتر صریح `tenant_id` تو هر Query، تست‌شده در `agentos-backend/test/`) کاملاً کافیه.
