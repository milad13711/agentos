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


`schema-postgres.sql` آماده‌ست ولی هنوز به اپلیکیشن وصل نیست، چون این یک تغییر واقعاً پرریسکه که باید جدا و با تست انجام بشه:

1. `npm install pg` در `agentos-backend`
2. در `src/db.js`: جایگزینی `new DatabaseSync(...)` با `new Pool({connectionString: process.env.DATABASE_URL})`
3. **تبدیل هر `db.prepare(sql).get/all/run(params)` به `await pool.query(sql, params)`** — این تنها قسمت واقعاً زمان‌بره، چون SQLite همزمان (sync) کار می‌کنه ولی `pg` ناهمزمان (async) — یعنی هر Route Handler که از `db` استفاده می‌کنه باید `async/await` بشه (اکثرشون از قبل async هستن، پس تغییر کمتر از چیزیه که فکر می‌کنی، ولی باید یکی‌یکی تست بشه)
4. Placeholder syntax فرق می‌کنه: SQLite از `?` استفاده می‌کنه، PostgreSQL از `$1, $2, ...` — این تبدیل باید در همه Query ها انجام بشه
5. برای هر درخواست، قبل از هر Query تنظیم کن: `SET LOCAL app.current_tenant_id = '<tenantId>'` تا RLS کار کنه
6. Migration داده موجود: یک اسکریپت one-off بنویس که از SQLite بخونه و به Postgres بنویسه (چون فرمت داده یکسانه، این ساده‌ست)

**توصیه من:** این مهاجرت رو در یک محیط با دسترسی واقعی به Postgres و امکان تست کامل انجام بده (مثلاً با Claude Code روی سیستم خودت، جایی که می‌تونی واقعاً `docker compose up` بزنی و هر تغییر رو تست کنی) — نه این‌که من اینجا کورکورانه ۷۰۰+ خط کد رو بدون امکان اجرا تغییر بدم و برات بفرستم. با SQLite فعلی، تا وقتی روی یک سرور تنها (نه چند Instance موازی) اجرا می‌کنی، کاملاً قابل‌اعتماده — خیلی از محصولات واقعی SaaS با SQLite در Production کار می‌کنن.
