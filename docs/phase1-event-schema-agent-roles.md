# فاز ۱ — پیش‌نویس: Event Schema + مدل Agent-as-Role

**وضعیت: پیش‌نویس، هیچ کدی هنوز تغییر نکرده.** این سند برای تأیید قبل از هر ریفکتوریه.

## هدف

بدهی فنی بند ۵ در CLAUDE.md رو ریشه‌ای حل کنیم: `create_contact`/`create_deal` (و در واقع تقریباً هر اکشن نویسا) الان **دقیقاً دوبار** پیاده‌سازی شده —
- یک‌بار در `server.js` (مسیر REST مستقیم، مثلاً `POST /api/contacts`)
- یک‌بار در `agent.js` → `executeAction()` (مسیر Agent)

هر دو مسیر SQL خودشون رو می‌نویسن، `audit()` رو جدا صدا می‌زنن، و منطق‌شون می‌تونه به‌مرور از هم جدا بیفته (باگ کلاسیک: یه قانون کسب‌وکار توی یکی اصلاح می‌شه، توی اون یکی یادت می‌ره).

راه‌حل پیشنهادی دو تکه‌ست که به هم وابسته‌ن:
1. **Event Schema** — یک نقطه‌ی واحد نوشتن (Action Registry) + یک جدول `events` که هم تاریخچه/audit رو یکپارچه می‌کنه، هم Approval Gate رو عمومی می‌کنه.
2. **Agent-as-Role** — به‌جای اینکه «Agent» یک رشته‌ی هاردکد (`actor_type = 'agent'`) و یک ستون شخصی‌سازی روی `users` باشه، به‌عنوان یک **نقش** در همون سیستم RBAC که از قبل نصفه‌کاره (owner/admin/member) وجود داره مدل بشه.

این طرح **event sourcing کامل نیست** — عمداً. state همچنان توی جدول‌های عادی (`contacts`, `deals`, ...) می‌مونه؛ `events` فقط تنها دروازه‌ی نوشتن و یک لاگ ضمیمه‌شونده (append-mostly) هست. برای یک بک‌اند بدون‌dependency و به این اندازه، event sourcing کامل بیش از حد لازمه.

## چیزی که الان واقعاً هست (خلاصه‌ی بررسی کد)

- `db.js`: جدول `audit_logs` (actor_type: `user`|`agent`, actor_id, action, entity, detail_json) — فقط لاگ، هیچ‌جا خونده نمی‌شه به‌جز نمایش (`/api/audit`, `/api/admin/audit`, KPI‌های Super Admin).
- `db.js`: جدول `pending_actions` (action, domain, params_json, status: pending/approved/rejected) — صف Approval Gate، مجزا از audit_logs.
- `agent.js`: `SENSITIVE_ACTIONS` یک `Set` هاردکد از نام اکشن‌هاست که تعیین می‌کنه چی باید بره صف approval — این قانون **فقط برای مسیر Agent** اعمال می‌شه؛ اگه یوزر مستقیم از `DELETE /api/deals/:id` بزنه، هیچ Approval Gate ای نیست (چون یوزر مستقیم صداش می‌زنه، نه از طریق `pending_actions`).
- نقش‌ها الان واقعاً `owner` | `admin` | `member` هستن (نه فقط owner/member که README می‌گه — `requireRole` توی `server.js` هر سه رو چک می‌کنه). Agent هیچ نقشی نداره؛ فقط یک رشته‌ی `actor_type='agent'` در audit، و `agent_name`/`agent_persona` روی خود کاربر انسانی که ازش استفاده می‌کنه.

## بخش ۱: Event Schema

### جدول جدید `events`

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  type          TEXT NOT NULL,        -- 'contact.created', 'deal.stage_changed', 'invoice.issued', ...
  actor_type    TEXT NOT NULL,        -- 'user' | 'agent' | 'system'
  actor_id      TEXT,                 -- users.id — همیشه انسانی که مسئوله (حتی وقتی actor_type='agent')
  actor_role    TEXT NOT NULL,        -- 'owner' | 'admin' | 'member' | 'agent'
  entity_type   TEXT,                 -- 'contact' | 'deal' | 'invoice' | 'module' | 'task' | ...
  entity_id     TEXT,
  payload_json  TEXT NOT NULL,        -- همون params فعلی (شکل هر type مشخص و مستنده)
  status        TEXT NOT NULL DEFAULT 'applied', -- 'applied' | 'pending_approval' | 'rejected'
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER              -- فقط برای status pending_approval → applied/rejected
);
CREATE INDEX idx_events_tenant ON events(tenant_id);
CREATE INDEX idx_events_entity ON events(entity_type, entity_id);
CREATE INDEX idx_events_status ON events(status);
```

نکته کلیدی: `actor_id` **همیشه** `users.id` انسان مسئوله — حتی وقتی `actor_type = 'agent'`. یعنی «Agent» عاملی نیست که خودش هویت مستقل داشته باشه؛ نماینده‌ی یک کاربر مشخصه، با یک نقش (role) متفاوت از نقش عادی همون کاربر. این دقیقاً همون چیزیه که بخش ۲ (Agent-as-Role) توضیح می‌ده.

### تصمیم معماری: `pending_actions` ادغام می‌شه در `events`

به‌جای دو جدول جدا (`audit_logs` برای تاریخچه + `pending_actions` برای صف تایید)، هر دو در `events` یکی می‌شن:
- اکشنی که نیاز به تایید نداره → یک ردیف با `status='applied'` مستقیم ثبت می‌شه (همون لحظه اجرا هم می‌شه).
- اکشن حساس → یک ردیف با `status='pending_approval'` ثبت می‌شه (چیزی اجرا نمی‌شه). با approve/reject، همون ردیف به `applied`/`rejected` آپدیت می‌شه (`resolved_at` ست می‌شه).

این یعنی `events` جای هر دو جدول `audit_logs` و `pending_actions` رو می‌گیره. `audit_logs` رو می‌شه بعداً حذف کرد یا برای سازگاری موقت به‌عنوان یک VIEW روی `events` نگه داشت (چون `/api/audit`, `/api/admin/audit`, و KPI‌های Super Admin الان مستقیم ازش می‌خونن).

**سوال بازی که نیاز به تأیید شما داره:** آیا مهاجرت دیتای موجود (audit_logs + pending_actions قدیمی) به events لازمه، یا چون این محیط production واقعی داره و داده‌ی تاریخی زیاد مهم نیست، از یک نقطه به بعد فقط events جدید نوشته بشه و جدول‌های قدیمی برای خواندن تاریخچه‌ی قبلی (read-only) بمونن؟ پیشنهاد من: گزینه‌ی دوم (ساده‌تر، بدون ریسک migration روی دیتابیس زنده‌ی سرور).

### الگوی نوشتن: یک Action Registry به‌جای دو پیاده‌سازی

هسته‌ی رفع بدهی فنی همینجاست. یک فایل جدید (مثلاً `src/actions.js`) جایگزین بخش `switch(action)` توی `agent.js` می‌شه، و **هم `server.js` هم `agent.js` از همینجا صدا می‌زنن**:

```js
// src/actions.js — تنها جایی که واقعاً به دیتابیس می‌نویسه
const registry = {
  create_contact: {
    domain: 'sales',
    sensitive: false,
    entityType: 'contact',
    apply(tenantId, params) {
      // همون منطق فعلی create_contact — یک‌بار، نه دوبار
    },
  },
  delete_deal: {
    domain: 'sales',
    sensitive: true,
    entityType: 'deal',
    apply(tenantId, params) { /* ... */ },
  },
  // ... بقیه‌ی اکشن‌های فعلی، عیناً از agent.js کپی می‌شن (منطق تغییر نمی‌کنه، فقط محل واحد می‌شه)
};

// نقطه‌ی ورود واحد — همه (هم server.js هم agent.js) از همینجا صدا می‌زنن
function dispatch(actor, type, params) {
  const def = registry[type];
  if (!def) throw new Error('unknown_action:' + type);

  const requiresApproval = def.sensitive && actor.role !== 'owner_override'; // جزئیات دقیق‌تر در بخش ۲
  const eventId = insertEvent(actor, type, def, params, requiresApproval ? 'pending_approval' : 'applied');

  if (requiresApproval) return { requiresApproval: true, eventId };
  const result = def.apply(actor.tenantId, params);
  return { requiresApproval: false, eventId, result };
}
```

- `server.js` برای `POST /api/contacts` می‌شه: `dispatch({type:'user', id:auth.userId, role:auth.role, tenantId:auth.tenantId}, 'create_contact', {name, phone})`
- `agent.js` برای همون اکشن (وقتی Agent تشخیص می‌ده) می‌شه: `dispatch({type:'agent', id:userId, role:'agent', tenantId}, 'create_contact', params)`

منطق SQL واقعی (`def.apply`) **یک‌بار** نوشته می‌شه. این دقیقاً بدهی فنی بند ۵ رو می‌بنده.

### Event Types نسخه ۱ (معادل مستقیم اکشن‌های فعلی — چیز جدیدی اضافه نمی‌شه)

هر `action` فعلی توی `DOMAIN_OF` (در `agent.js`) یک `type` معادل می‌گیره، با کانونشن `entity.verb`:

| اکشن فعلی | type پیشنهادی | حساس؟ |
|---|---|---|
| create_contact | `contact.created` | خیر |
| delete_contact | `contact.deleted` | بله |
| create_deal | `deal.created` | خیر |
| update_deal_stage | `deal.stage_changed` | خیر |
| delete_deal | `deal.deleted` | بله |
| issue_invoice | `invoice.issued` | بله |
| build_module | `module.created` | بله |
| delete_module | `module.deleted` | بله |
| publish_module | `marketplace.published` | بله |
| install_module | `module.installed` | بله |
| create_task | `task.created` | خیر |
| delegate_task | `task.delegated` | خیر |
| generate_report | `report.generated` | خیر |
| ... | ... | ... |

(لیست کامل معادل همون چیزیه که الان در `SENSITIVE_ACTIONS` و `DOMAIN_OF` در `agent.js` هست — چیزی کم/زیاد نمی‌شه، فقط نام‌گذاری یکدست‌تر می‌شه.)

---

## بخش ۲: مدل Agent-as-Role

### مشکل فعلی

«Agent» الان سه جای مختلف، سه شکل مختلف نمایش داده می‌شه:
1. در `audit_logs.actor_type`: یک رشته‌ی هاردکد `'agent'` در برابر `'user'`.
2. در `users` table: `agent_name` و `agent_persona` — شخصی‌سازی *لحن* Agent، نه یک هویت یا نقش.
3. در `agent.js`: `SENSITIVE_ACTIONS` یک Set هاردکد که تعیین می‌کنه Agent چه‌کاری بدون تایید نمی‌تونه انجام بده — ولی این قانون فقط وقتی اعمال می‌شه که مسیر اجرا از `agent.js` بیاد. RBAC انسانی (`owner`/`admin`/`member`) کاملاً جدا و بی‌ربط به این تعریفه.

نتیجه: دو سیستم مجوز موازی و ناهماهنگ داریم — یکی برای انسان‌ها (role-based، توی `requireRole`)، یکی برای Agent (action-name-based، توی `SENSITIVE_ACTIONS`). این دقیقاً همون چیزیه که README به‌عنوان «RBAC واقعی نداریم، Permission Matrix نداریم» اشاره کرده.

### مدل پیشنهادی: Agent یک Role است، نه یک Actor Type جدا

به‌جای `actor_type: 'user' | 'agent'` به‌عنوان یک بعد جدا از role، پیشنهاد اینه که **Agent یکی از مقادیر همون ستون role باشه**:

```
نقش‌های ممکن یک actor: owner | admin | member | agent
```

هر actor (چه یک request مستقیم از کاربر لاگین‌شده، چه یک اکشنی که از داخل `agent.js` می‌آد) قبل از رسیدن به `dispatch()` یک شیء استاندارد می‌سازه:

```ts
type Actor = {
  tenantId: string;
  userId: string;   // انسانی که مسئول نهاییه — همیشه پر است، حتی برای role='agent'
  role: 'owner' | 'admin' | 'member' | 'agent';
};
```

وقتی یک کاربر با `agent.js` صحبت می‌کنه، actor ساخته‌شده `{ tenantId, userId, role: 'agent' }` است — **نه** `role` واقعی اون کاربر (owner/admin/member). یعنی «داره از طرف این کاربر، ولی با محدودیت‌های نقش Agent، عمل می‌کنه» — دقیقاً مثل sudo با یک پروفایل محدودتر، نه نامحدودتر.

### Capability Matrix (جایگزین `SENSITIVE_ACTIONS` هاردکد + `requireRole` پراکنده)

یک جدول واحد (فعلاً به‌صورت یک شیء ثابت در کد، **نه** جدول دیتابیس جدا — چون over-engineering برای این مرحله‌ست؛ اگه بعداً نیاز به تنظیم پویا از Super Admin شد، می‌شه بردش توی دیتابیس):

```js
// src/roles.js
const ROLES = {
  owner:  { canDispatchAll: true },
  admin:  { deny: ['tenant.delete'] },
  member: { deny: ['*.deleted', 'invoice.*', 'marketplace.*', 'module.*'] },
  agent:  { requiresApproval: [
    'invoice.issued', 'deal.deleted', 'contact.deleted',
    'module.created', 'module.deleted', 'marketplace.published', 'module.installed',
  ] },
};
```

این دقیقاً همون لیست فعلی `SENSITIVE_ACTIONS` است — چیزی رفتاری عوض نمی‌شه، فقط محل تعریفش از یک `Set` گمشده وسط `agent.js` به یک جدول صریح و قابل‌گسترش برای همه‌ی نقش‌ها منتقل می‌شه.

### چرا این مهمه (نه فقط تمیزکاری)

1. **رفع بدهی فنی بند ۵**: چون `dispatch()` یکیه و actor.role رو می‌گیره، دیگه لازم نیست `server.js` و `agent.js` جدا جدا تصمیم بگیرن این اکشن حساسه یا نه.
2. **پایه برای RBAC واقعی** (فاز بعدی روی لیست تکنیکال دبت README): وقتی Agent هم یک role است، اضافه‌کردن یک role محدودتر مثل `agent:readonly` (مثلاً برای پلن‌های پایین‌تر که فقط اجازه‌ی report/list دارن) فقط یعنی یک ردیف جدید در `ROLES`، نه کد جدید.
3. **مسیر باز برای چند-Agent در آینده** (خارج از اسکوپ فاز ۱، فقط اشاره): اگه یک روز خواستید Agent مخصوص یک نقش محدودتر (مثلاً فقط دامنه `finance`) داشته باشید، مدل از قبل جواب می‌ده — چون role چیزیه که با domain/capability تعریف می‌شه، نه یک flag دودویی.

### چیزی که این مدل *تغییر نمی‌ده*

- `agent_name` و `agent_persona` دست‌نخورده می‌مونن — اینا شخصی‌سازی لحن System Prompت هستن، نه بخشی از سیستم مجوز. کاملاً orthogonal به Agent-as-Role.
- رفتار فعلی approval gate از دید کاربر نهایی عوض نمی‌شه — همون اکشن‌هایی که الان نیاز به تایید دارن، دقیقاً همونا می‌مونن.

---

## چک‌لیست پیاده‌سازی — همه انجام شد ✅

- [x] جدول `events` به `db.js` اضافه شد (additive، سپس در همین فاز نهایی شد)
- [x] `src/actions.js` ساخته شد: یک `dispatch()` واحد + registry برای هر اکشن CRUD (هم از `server.js` هم `agent.js` صدا زده می‌شه)
- [x] `src/roles.js` ساخته شد با Capability Matrix (معادل دقیق `SENSITIVE_ACTIONS` قبلی، فقط بر اساس نقش)
- [x] `agent.js` بازنویسی شد: اکشن‌های حساس هم از `dispatch()`/`resolveEvent()` رد می‌شن (نه دیگه `pending_actions`)
- [x] `server.js`: همه هندلرهای REST دارای معادل Agent (contacts/deals/invoices/modules/marketplace/tasks-create) به `dispatch()` وصل شدن
- [x] `/api/audit`, `/api/admin/audit`, KPIها، و لیست/جزئیات Tenant به `events` وصل شدن
- [x] `audit()` (در `agent.js`) به‌جای نوشتن در `audit_logs`، مستقیم در `events` می‌نویسه — یعنی رویدادهای غیر-CRUD (ثبت‌نام Tenant، تغییر نقش تیم، تایید/رد Approval، تنظیمات Admin و...) هم دیگه یک منبع دارن، نه دو تا
- [x] audit()های تکراری بعد از `dispatch()` حذف شدن (چون خودِ `dispatch()` همون event رو ثبت می‌کنه)
- [x] `CREATE TABLE audit_logs/pending_actions` از `db.js` حذف شد — نصب‌های تازه دیگه این جدول‌ها رو نمی‌سازن؛ روی دیتابیس‌های موجود (مثل سرور production) دست‌نخورده می‌مونن تا backfill اجرا بشه
- [x] `scripts/backfill-audit-to-events.js` نوشته و تست شد: `audit_logs` قدیمی رو با `status='executed'` کپی می‌کنه (idempotent، دوباره اجرا کردنش امنه)، و با فلگ `--drop-legacy-tables` جدول‌های قدیمی رو حذف می‌کنه
- [x] تست دستی محلی: تمام اکشن‌های غیرحساس و حساس (create/update/delete/issue_invoice/build_module/publish/install) هم از REST هم از Agent، رفتار و خروجی یکسان — شامل مسیر Approval Gate (queue → approve/reject → already_resolved) و dedupe guard برای `build_module`

## سوالات باز — پاسخ داده شد

1. **مهاجرت دیتای تاریخی**: طبق تصمیم شما، اسکریپت one-off نوشته شد (`scripts/backfill-audit-to-events.js`, ~۴۰ خط با کامنت). `audit_logs` قدیمی با `status='executed'` کپی می‌شه تا از رویدادهای زنده (`applied`) قابل تفکیک باشه.
2. **سرنوشت `audit_logs`**: کامل Deprecate شد، نه VIEW موازی. کد دیگه چیزی توش نمی‌نویسه یا نمی‌خونه؛ فقط تا وقتی خودِ اسکریپت روی سرور production اجرا نشه، جدول قدیمی (با دیتای واقعی) دست‌نخورده باقی می‌مونه.
3. **ترتیب**: دقیقاً طبق ۵ قدم شما پیش رفتیم و همه لوکال تست شدن (قدم ۱ تا ۴).

## قدم ۵ — دیپلوی روی Production (نیاز به اقدام دستی شما)

این session به سرور `94.182.93.52` دسترسی SSH نداره (شبکه sandbox فقط HTTP/HTTPS پروکسی‌شده رو اجازه می‌ده، نه TCP خام روی پورت ۲۲). یعنی نمی‌تونم مستقیم دیپلوی کنم. مراحل پیشنهادی برای شما روی سرور:

```bash
# ۱. کد جدید رو به سرور برسون (git pull اگر ریپو رو اونجا هم clone کردید، یا scp مثل قبل)
# ۲. قبل از هر چیز، از دیتابیس زنده یک بکاپ بگیر:
cp agentos-backend/data/agentos.sqlite agentos-backend/data/agentos.sqlite.bak-$(date +%s)

# ۳. سرویس‌ها رو با کد جدید بالا بیار (این خودش schema رو صرفاً additive آپدیت می‌کنه — چیزی حذف نمی‌شه)
docker compose up -d --build

# ۴. فقط بعد از چک‌کردن اینکه همه‌چیز درست کار می‌کنه (چند روز مانیتور، یا حداقل چند ساعت)،
#    اسکریپت backfill رو داخل کانتینر اجرا کن (بدون --drop-legacy-tables اول، برای دیدن نتیجه):
docker compose exec backend node scripts/backfill-audit-to-events.js

# ۵. بعد از تایید (مثلاً با یک کوئری دستی که تعداد ردیف‌های events با status='executed' منطقیه)،
#    دوباره با فلگ حذف اجرا کن:
docker compose exec backend node scripts/backfill-audit-to-events.js --drop-legacy-tables
```

اگه بخواید، می‌تونم دستورات دقیق‌تر رو هم آماده کنم — ولی خودِ اجراش روی سرور باید دست شما باشه.
