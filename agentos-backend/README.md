# AgentOS Backend — نسخه واقعی (Real Backend)

این یک **بک‌اند واقعی و اجراشونده** است، نه شبیه‌سازی درون‌مرورگری. بدون هیچ وابستگی بیرونی (فقط ماژول‌های داخلی Node.js) نوشته شده تا در هر محیطی — حتی بدون دسترسی به npm registry — مستقیم اجرا و تست بشه. تمام تست‌های زیر واقعاً روی این کد اجرا و تایید شدن (نه فرضی).

## اجرا

```bash
node src/server.js
# یا برای توسعه با ری‌استارت خودکار:
npm run dev
```

سرور روی `http://localhost:8787` بالا می‌آد. یک فایل SQLite واقعی در `data/agentos.sqlite` ساخته می‌شه (روی دیسک، persistent).

### متغیرهای محیطی

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PORT` | `8787` | پورت HTTP |
| `AGENTOS_DB_PATH` | `data/agentos.sqlite` | مسیر فایل دیتابیس |
| `AGENTOS_TOKEN_SECRET` | تصادفی در هر boot | **در Production حتماً یک مقدار ثابت و طولانی تنظیم کن**، وگرنه با هر ری‌استارت همه توکن‌ها باطل می‌شن |
| `ANTHROPIC_API_KEY` | — | برای فعال‌سازی AI Gateway واقعی. بدون این، `/api/agent/act` روی حالت `DEV_MOCK` (چند الگوی ساده فارسی، فقط برای تست آفلاین) کار می‌کنه |
| `AGENTOS_MODEL` | `claude-sonnet-4-6` | مدل مورد استفاده |

## معماری این نسخه

```
src/
  db.js      → Schema واقعی SQL (SQLite via node:sqlite) + ایجاد جداول
  auth.js    → هش رمز عبور واقعی (scrypt) + توکن امضاشده HMAC (معادل JWT)
  agent.js   → AI Gateway + System Prompt + اجرای اکشن روی دیتابیس واقعی + Approval Queue
  server.js  → HTTP Router دستی (بدون فریم‌ورک) + تمام Endpointها
```

بدون فریم‌ورک/ORM ساخته شده چون این محیط به npm registry دسترسی نداشت. **برای استقرار واقعی، جایگزینی `node:sqlite` با PostgreSQL و اضافه‌کردن Express/Fastify کاملاً روتین است** — همه‌ی Queryها SQL خام‌اند و مستقیم قابل‌کپی به `pg` هستن.

## چیزهایی که واقعاً پیاده‌سازی و تست شدن

- ثبت‌نام/ورود واقعی با هش رمز عبور (scrypt) — رمز هیچ‌وقت plain ذخیره نمی‌شه ✅
- توکن نشست امضاشده (HMAC-SHA256)، قابل‌جعل نیست، انقضا ۱۲ ساعته ✅
- **Multi-Tenant Isolation واقعی**: تست شد که Tenant B هیچ داده‌ای از Tenant A (نه دیل، نه رکورد ماژول) نمی‌بینه ✅
- **Approval Gate واقعی**: اکشن حساس (`issue_invoice`, `delete_deal`, `delete_contact`, `build_module`, `publish_module`, `install_module`) در دیتابیس روی `pending` می‌مونه و **تا approve نشه، هیچ تغییری در داده اعمال نمی‌شه** — این با تست مستقیم تایید شد ✅
- Idempotency: approve دوباره روی یک pending حل‌شده خطا می‌ده ✅
- **Marketplace بین Tenantها واقعاً کار می‌کنه روی جدول جدا و global**: فقط Schema منتشر می‌شه، هیچ داده‌ای از رکوردهای واقعی Tenant منتشرکننده به مشترکین منتقل نمی‌شه — تست شد ✅
- Audit Log واقعی با actor/action/entity/timestamp برای هر عملیات ✅
- Rate limiting ساده روی `/api/auth/*` ✅
- CORS + محافظت پایه در برابر body بیش‌ازحد بزرگ (۱MB) ✅

## چیزهایی که هنوز باقی مونده (روی همین کد باید اضافه بشه)

- RBAC واقعی (الان فقط owner/member داریم، بدون Permission Matrix)
- HTTPS/TLS (باید پشت یک Reverse Proxy مثل Caddy/Nginx یا یک Load Balancer با TLS بیاد)
- PostgreSQL واقعی به‌جای SQLite (برای Concurrency و Row-Level Security بومی)
- Refresh Token / Revocation List (الان توکن فقط با انقضا باطل می‌شه، امکان Logout اجباری نیست)
- تست خودکار (Unit/Integration) — تست‌های دستی زیر اجرا شدن ولی در CI نیستن

## Super Admin Dashboard (جدید)

یک کاربر با ایمیلی که در `SUPER_ADMIN_EMAIL` تنظیم می‌کنی، با اولین ثبت‌نام یا ورود، خودکار Super Admin می‌شه:

```bash
export SUPER_ADMIN_EMAIL="you@yourcompany.com"
```

سپس با همون ایمیل از `frontend-local/index.html` یا مستقیم از API ثبت‌نام کن. بعدش `frontend-local/admin.html` رو باز کن و با همون ایمیل/رمز وارد شو.

داشبورد Super Admin شامل:
- **نمای کلی (KPI)**: تعداد Tenant/کاربر، توزیع پلن‌ها، MRR تخمینی، دوره‌های آزمایشی فعال، اکشن‌های Agent در ۲۴ ساعت گذشته، صف تایید، وضعیت زنده/آفلاین AI Gateway
- **Tenantها**: تغییر پلن هر Tenant، تعلیق/فعال‌سازی (Tenant معلق‌شده بلافاصله از همه APIها 403 می‌گیره — تست شد)
- **پلن‌ها**: ویرایش قیمت ماهانه/سالانه و سقف‌های هر پلن (سقف ماژول واقعاً در بک‌اند enforce می‌شه — تست شد که با رسیدن به سقف، خطای `plan_limit_reached` برمی‌گرده)
- **Marketplace**: مخفی/فعال‌کردن هر ماژول منتشرشده (Moderation)
- **Audit Log سراسری**: فید همه رویدادهای همه Tenantها

## Frontend محلی (جدید) — `frontend-local/`

دو فایل مستقل، بدون build step، مستقیم با دابل‌کلیک یا یک static server ساده باز می‌شن:
- **`index.html`**: فرانت‌اند Tenant — ثبت‌نام/ورود واقعی، چت با Agent از طریق `/api/agent/act`، تایید/رد عملیات حساس، سایدبار زنده از داده واقعی
- **`admin.html`**: داشبورد Super Admin (بالا توضیح داده شد)

هر دو یک فیلد «API Base URL» در صفحه ورود دارن (پیش‌فرض `http://localhost:8787`) — یعنی همین فایل‌ها بدون تغییر کد، بعد از دیپلوی بک‌اند روی سرور واقعی، فقط با عوض‌کردن این آدرس به اون سرور وصل می‌شن.

⚠️ این‌ها فرانت‌اند نهایی Production نیستن (اون در فاز ۲ / Next.js می‌آد — نگاه کن به `PHASE-2-DESIGN.md`)، بلکه ابزار توسعه محلی برای تست واقعی بک‌اند و ادامه توسعه هستن.



```bash
# ثبت‌نام Tenant جدید
curl -X POST http://localhost:8787/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"tenantName":"شرکت پارسه","name":"علی رضایی","email":"ali@parseh.test","password":"password123"}'

# → { "token": "...", "tenant": {...}, "user": {...} }

# ساخت مخاطب
curl -X POST http://localhost:8787/api/contacts \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"محمد کریمی","phone":"09121234567"}'

# دستور به Agent (نیاز به ANTHROPIC_API_KEY برای پاسخ واقعی، وگرنه DEV_MOCK)
curl -X POST http://localhost:8787/api/agent/act \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"برای معامله «قرارداد نرم‌افزار» فاکتور صادر کن"}'
# → { "requiresApproval": true, "pendingId": "...", ... }

curl -X POST http://localhost:8787/api/agent/pending/$PENDING_ID/approve \
  -H "Authorization: Bearer $TOKEN"
```

فهرست کامل Endpointها در `src/server.js` مستقیماً قابل‌مشاهده‌ست (هر `route(...)` یک Endpoint مستقله).

## قابلیت‌های جدید (فاز تیم/RBAC/گزارش/صدا)

### مدل قیمت‌گذاری جدید — تومان، ۴ سطح، مبتنی بر روانشناسی قیمت‌گذاری
پلن‌ها از دلار/۳سطحی به تومان/۴سطحی تغییر کردن (منبع حقیقت: جدول `plans`، از طریق `/api/plans` عمومی یا Super Admin قابل مدیریت):

| پلن | ماهانه | سالانه | منطق |
|---|---|---|---|
| رایگان | ۰ | ۰ | حذف اصطکاک ثبت‌نام |
| استارتاپی | ۹۹۰,۰۰۰ | ۹,۹۰۰,۰۰۰ | قدم کم‌ریسک بعد از رایگان |
| حرفه‌ای | ۲,۹۹۰,۰۰۰ | ۲۹,۹۰۰,۰۰۰ | «محبوب‌ترین» — Anchor پایینی |
| سازمانی | ۹,۹۰۰,۰۰۰ | ۹۹,۰۰۰,۰۰۰ | Anchor بالا — پلن حرفه‌ای رو منطقی جلوه می‌ده (اثر Decoy) |

تخفیف سالانه ~۱۷٪ نسبت به ماهانه×۱۲ (روانشناسی متعارف SaaS برای تشویق تعهد سالانه). هر پلن یک `features_json` داره (`team`, `voice`, `reports`, `marketplacePublish`, `customAgentPersona`, ...) که واقعاً توسط بک‌اند enforce می‌شه، نه فقط تزئینی.

### RBAC / مدیریت پرسنل (`/api/team/*`)
سه نقش: `owner` (کامل) → `admin` (می‌تونه پرسنل اضافه/حذف کنه) → `member` (محدود). Owner با `POST /api/team/invite` پرسنل جدید می‌سازه؛ چون این محیط SMTP نداره، رمز موقت مستقیم در پاسخ API برگردونده می‌شه (در Production باید ایمیل بشه). سقف `seats_limit` پلن واقعاً enforce می‌شه.

### وظایف، یادآور، ارجاع (`/api/tasks/*`)
هر Task یک `assignee_id` داره؛ «ارجاع» یعنی همون تغییر `assigneeId` — در Audit Log به‌صورت `delegate_task` جدا از `update_task` ثبت می‌شه.

### شخصی‌سازی Agent هر کاربر (`PATCH /api/me/agent`)
هر عضو تیم می‌تونه `agentName` و `agentPersona` خودش رو تنظیم کنه؛ این مستقیم داخل System Prompt در `agent.js` تزریق می‌شه، یعنی واقعاً روی لحن پاسخ Agent اثر می‌ذاره. این قابلیت پشت `features.customAgentPersona` پلن قفل شده (پلن رایگان اجازه نداره — تست شد).

### گزارش‌های Excel/PDF واقعی
- **Excel**: `GET /api/reports/{contacts|deals|invoices|tasks}.xlsx` یک فایل **.xlsx واقعی** برمی‌گردونه — نه CSV با پسوند جعلی. فایل با دست (بدون هیچ کتابخانه‌ای) به‌صورت OOXML/ZIP واقعی در `src/xlsx-writer.js` ساخته می‌شه و با `openpyxl` پایتون validate شده. نسخه `.csv` هم برای سازگاری ساده هنوز موجوده.
- **PDF**: عمداً سمت سرور تولید نشده. یک PDF دست‌ساز بدون کتابخانه نمی‌تونه گلیف‌های فارسی/عربی رو درست رندر کنه (فونت Helvetica استاندارد پشتیبانی نداره). به‌جاش، `frontend-local/index.html` یک نمای چاپی HTML می‌سازه و `window.print()` مرورگر رو صدا می‌زنه — این تنها راه بدون-وابستگی برای PDF فارسی/RTL صحیحه.
- Agent هم می‌تونه با جمله فارسی («گزارش اکسل معاملات رو بساز») این گزارش‌ها رو بسازه (اکشن `generate_report`).

### گفتگوی صوتی
از **Web Speech API** مرورگر استفاده می‌شه (بدون هیچ سرویس یا کتابخانه بیرونی): `SpeechRecognition` برای ورودی صدا (دکمه 🎙️)، `SpeechSynthesis` برای خوندن پاسخ Agent. پشتیبانی به مرورگر بستگی داره (Chrome بهترین پشتیبانی fa-IR رو داره).

### پالت رنگی حرفه‌ای جدید
هر دو فایل `frontend-local/*.html` از یک پالت جدید استفاده می‌کنن (به‌جای زرد/فیروزه‌ای قبلی): نیوی سرد تیره + یک رنگ طلایی/برنز کم‌اشباع به‌عنوان تنها Accent، رنگ‌های وضعیت (موفقیت/خطا) کم‌اشباع‌تر — رویکرد استاندارد SaaS سازمانی به‌جای ظاهر اپ مصرفی. توکن‌های رنگ در `:root` هر فایل مستند شده و آماده جایگزینی با Character Sheet برند واقعی هستن.

✅ **صفحه لندینگ چندزبانه (`agentos-landing.html`) به‌روزرسانی شد**: همون پالت حرفه‌ای بالا رو گرفته، و جدول قیمت‌گذاری حالا ۴ سطحی و بر پایه تومانه (منطبق با `plans` بک‌اند). صفحه لندینگ در بوت، `/api/plans` رو از بک‌اند واقعی فچ می‌کنه و اگه در دسترس نبود (مثلاً موقع پیش‌نمایش بدون بک‌اند)، روی همون اعداد Seed پیش‌فرض fallback می‌کنه — یعنی قیمت‌ها همیشه با Super Admin Dashboard همگام می‌مونن، نه یک عدد هاردکد جدا.

## مسیر مهاجرت به PostgreSQL (وقتی به اینترنت/Registry دسترسی داشتی)

1. `npm install pg`
2. در `db.js`: جایگزینی `new DatabaseSync(...)` با یک Connection Pool از `pg`
3. تبدیل `db.prepare(sql).get/all/run(...)` به `pool.query(sql, params)` — چون همه Queryها از قبل SQL خام و parameterized هستن، این یک تبدیل مکانیکی و کم‌ریسکه
4. اضافه‌کردن `ROW LEVEL SECURITY` واقعی روی هر جدول (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + Policy بر اساس `tenant_id`) به‌جای تکیه‌ی صرف به فیلتر لایه اپلیکیشن
