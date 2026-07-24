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
* دامنه: `exirsms.ir` — DNS هنوز کامل جا نیفتاده (IRNIC نیاز به Name Server داره، نه رکورد A مستقیم؛ پیشنهاد: Cloudflare رایگان)
* فعلاً روی HTTP خام کار می‌کنه (نه HTTPS) — یعنی `ALLOW_INSECURE_COOKIE=1` توی `docker-compose.yml` سرویس `web` ست شده. این باید حذف بشه وقتی HTTPS واقعی (از طریق Caddy + دامنه) فعال شد.
* AI Gateway: GapGPT (پروکسی ایرانی سازگار با OpenAI API) با مدل `gapgpt-qwen-3.5`، `OPENAI_BASE_URL=https://api.gapgpt.app/v1`
* Zarinpal: در حالت Sandbox (`ZARINPAL_SANDBOX=1`)، هنوز Merchant ID واقعی نداره

## گیرهای مهم (وقت زیادی صرف کشفشون شد — دوباره بهشون گیر نکن)

1. `env-loader.js` اولین مقدار رو نگه می‌داره، نه آخری — اگه یک متغیر توی `.env` دوبار تعریف بشه، خط اول برنده‌ست. همیشه بعد از ویرایش `.env`، با `grep -c "^KEY="` چک کن که هر متغیر دقیقاً یک‌بار باشه.
2. Next.js Dockerfile نیاز به پوشه `public/` داره (`COPY --from=builder /app/public ./public`) — اگه این پوشه نباشه build fail می‌شه. یک `public/robots.txt` نمونه از قبل توی پروژه هست، حذفش نکن.
3. کوکی نشست (`lib/session.ts`) با `secure: NODE_ENV==='production'` — روی HTTP خام (بدون TLS)، این باعث می‌شه مرورگر کوکی رو اصلاً ذخیره نکنه (لاگین "بی‌صدا" fail می‌شه). راه‌حل موقت: `ALLOW_INSECURE_COOKIE=1` در env سرویس `web`. باید بعد از فعال‌شدن HTTPS واقعی حذف بشه.
4. بک‌اند در `docker-compose.yml` به بیرون expose نمی‌شه (عمداً — کلید AI هیچ‌وقت نباید در معرض شبکه باشه). فقط از طریق شبکه داخلی Docker با `web` صحبت می‌کنه. اگه خواستی مستقیم تستش کنی: `docker compose exec web wget -qO- http://backend:8787/api/health`
5. بدهی فنی شناخته‌شده: منطق `create_contact`/`create_deal` دقیقاً دوبار پیاده‌سازی شده — یک‌بار در `server.js` (مسیر REST مستقیم)، یک‌بار در `agent.js` (مسیر Agent). یکی‌کردنشون هنوز انجام نشده.
6. Node 22 لازمه (نه کمتر) — چون از `node:sqlite` استفاده می‌کنیم که Native و بدون هیچ dependency خارجیه.
7. این پروژه از فاز ۰ به بعد یک Git repository واقعی داره (`git init` شده، `.gitignore` مناسب داره). از این به بعد هر تغییری باید commit بشه — دیگه کپی‌کردن zip/scp دستی نکن.

## پلن‌ها

(تومان، منبع حقیقت: جدول `plans` در دیتابیس، نه کد هاردکد)
Free (۰) → Starter (۹۹۰هزار/ماه) → Pro (۲.۹۹۹میلیون/ماه، محبوب‌ترین) → Enterprise (شروع از ۹.۹میلیون/ماه، سقف سالانه ۹۹میلیون)

## فازهای باقی‌مانده (اولویت‌بندی‌شده)

1. رفع بدهی فنی گفته‌شده در بند ۵ بالا (یکی‌کردن منطق دوباره‌پیاده‌سازی‌شده create_contact/create_deal) — طرح اولیه‌اش در فاز ۱ با Event schema + مدل Agent-as-Role شروع شده، ببین `docs/phase1-event-schema-agent-roles.md`
2. HTTPS واقعی (بعد از حل DNS) + حذف `ALLOW_INSECURE_COOKIE`
3. راه‌اندازی CI/CD ساده (git pull + rebuild روی سرور به‌جای scp دستی)
4. Marketplace UI در Next.js (بک‌اندش آماده‌ست)
5. مهاجرت PostgreSQL (فقط وقتی واقعاً به چند Instance نیاز شد — `schema-postgres.sql` آماده‌ست ولی وایر نشده؛ چک‌لیست کامل در `agentos-deploy/DEPLOY.md`)
6. Zarinpal واقعی (خروج از Sandbox)
