// agent.js — the real "Agent-First" core: turns Persian natural language into
// a structured action, executes it against the real database, and enforces
// the Human-in-the-loop Approval Gate for sensitive actions.
//
// This is the server-side authoritative version of the logic that the
// front-end prototype simulated in-browser. The AI Gateway call here is real:
// it calls the Anthropic Messages API over the network using ANTHROPIC_API_KEY.
//
// If ANTHROPIC_API_KEY is not set, a tiny local heuristic parser is used
// instead (DEV_MOCK) purely so the rest of the pipeline (DB writes, approval
// queue, audit log) can be exercised offline. It is NOT a substitute for the
// real model in production — see README.

const { db, uid, now } = require('./db');
const { dispatch } = require('./actions');

const STAGES = ['سرنخ', 'در حال مذاکره', 'پیشنهاد ارسال‌شده', 'برنده', 'ازدست‌رفته'];
const SENSITIVE_ACTIONS = new Set([
  'issue_invoice', 'delete_deal', 'delete_contact',
  'build_module', 'delete_module', 'publish_module', 'install_module'
]);
const DOMAIN_OF = {
  create_contact: 'sales', create_deal: 'sales', update_deal_stage: 'sales',
  delete_deal: 'sales', delete_contact: 'sales', list_contacts: 'sales',
  list_deals: 'sales', report: 'sales',
  issue_invoice: 'finance', list_invoices: 'finance',
  build_module: 'builder', delete_module: 'builder', module_create_record: 'builder', module_list_records: 'builder',
  publish_module: 'builder', install_module: 'builder', list_marketplace: 'builder',
  create_task: 'team', list_tasks: 'team', delegate_task: 'team',
  generate_report: 'reports',
  none: 'none'
};

function dataSnapshot(tenantId) {
  const contactCount = db.prepare('SELECT COUNT(*) c FROM contacts WHERE tenant_id = ?').get(tenantId).c;
  const dealCount = db.prepare('SELECT COUNT(*) c FROM deals WHERE tenant_id = ?').get(tenantId).c;
  const recentDeals = db.prepare('SELECT title, contact_name, amount, stage FROM deals WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10').all(tenantId);
  const recentContacts = db.prepare('SELECT name, phone, company FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10').all(tenantId);
  const modules = db.prepare('SELECT id, name, fields_json FROM custom_modules WHERE tenant_id = ?').all(tenantId);
  const marketItems = db.prepare('SELECT name, fields_json, published_by_tenant FROM marketplace_modules WHERE enabled = 1').all();
  const teamMembers = db.prepare(`SELECT name FROM users WHERE tenant_id = ? AND status = 'active'`).all(tenantId);

  const modulesDesc = modules.length
    ? modules.map(m => {
        const fields = JSON.parse(m.fields_json);
        const records = db.prepare('SELECT values_json FROM module_records WHERE module_id = ? ORDER BY created_at DESC LIMIT 8').all(m.id);
        const recordCount = db.prepare('SELECT COUNT(*) c FROM module_records WHERE module_id = ?').get(m.id).c;
        const recordsDesc = records.length
          ? records.map(r => {
              const v = JSON.parse(r.values_json || '{}');
              return '{' + fields.map(f => `${f.key}=${v[f.key] ?? '—'}`).join('، ') + '}';
            }).join(' | ')
          : 'هیچ رکوردی ثبت نشده';
        return `«${m.name}» (فیلدها: ${fields.map(f => f.key).join('، ')}) — ${recordCount} رکورد ثبت‌شده — رکوردهای اخیر: ${recordsDesc}`;
      }).join('\n  ')
    : 'هیچ ماژول محلی وجود ندارد';
  const marketDesc = marketItems.length
    ? marketItems.map(m => `«${m.name}» (منتشرشده توسط ${m.published_by_tenant})`).join(' | ')
    : 'Marketplace خالی است';
  const teamDesc = teamMembers.length ? teamMembers.map(u => u.name).join('، ') : 'فقط خود کاربر';
  const dealsDesc = recentDeals.length
    ? recentDeals.map(d => `${d.title} — مخاطب: ${d.contact_name || 'ثبت‌نشده'} — مبلغ: ${d.amount || '—'} — مرحله: ${d.stage}`).join(' | ')
    : 'ندارد';
  const contactsDesc = recentContacts.length
    ? recentContacts.map(c => `${c.name} — تلفن: ${c.phone || 'ثبت‌نشده'}${c.company ? ' — شرکت: ' + c.company : ''}`).join(' | ')
    : 'ندارد';

  return `تعداد مخاطبین: ${contactCount}
تعداد معاملات: ${dealCount}
جزئیات معاملات اخیر (شامل نام/شماره مخاطب هرکدوم — برای سوالات درباره شماره تلفن یا مبلغ یک سرنخ/معامله خاص از همینجا جواب بده): ${dealsDesc}
جزئیات مخاطبین اخیر: ${contactsDesc}
مراحل معتبر معامله: ${STAGES.join(' | ')}
ماژول‌های محلی و رکوردهای واقعی داخلشون (این ماژول‌ها همین الان ساخته و فعال شدن — هیچ مرحله جداگانه «فعال‌سازی» یا انتظار وجود نداره؛ برای سوالات درباره تکراری‌بودن یا وجود یک رکورد خاص، دقیقاً از همین رکوردهای واقعی جواب بده، نه حدس یا «در حال بررسی»):
  ${modulesDesc}
ماژول‌های Marketplace: ${marketDesc}
اعضای تیم (برای ارجاع وظیفه): ${teamDesc}`;
}

function buildSystemPrompt(tenantId, agentName, agentPersona) {
  const personaLine = agentPersona
    ? `نام تو «${agentName}» است و باید با این شخصیت پاسخ بدی: ${agentPersona}`
    : `نام تو «${agentName}» است.`;
  return `تو ${personaLine}
تو Orchestrator Agent در سیستم AgentOS هستی و درخواست فارسی کاربر را به یک اکشن ساختاریافته تبدیل می‌کنی.

وضعیت فعلی داده این Tenant:
${dataSnapshot(tenantId)}

اکشن‌های مجاز (هرکدام domain مشخصی دارد: sales | finance | builder | team | reports | none):
- create_contact {name, phone?, company?}
- create_deal {title, contactName?, amount?, stage?}
- update_deal_stage {dealTitle, newStage}
- delete_deal {dealTitle} — حساس
- delete_contact {name} — حساس
- list_contacts {}
- list_deals {stage?} — اگه stage داده بشه فقط دیل‌های همون مرحله برمی‌گرده
- report {}
- issue_invoice {dealTitle, amount?} — حساس. dealTitle باید دقیقاً به معامله‌ای که کاربر اشاره کرده مربوط باشه (بر اساس عنوان یا نام مشتری در «جزئیات معاملات اخیر» بالا). اگه معامله‌ای برای مشتری موردنظر پیدا نکردی، **هرگز فاکتور رو به یک معامله یا مشتری دیگه (حتی مشابه یا اخیر) وصل نکن** — به‌جاش یا اول با create_deal یک معامله برای همون مشتری بساز و بعد فاکتور بزن، یا اگه نامشخصه، action را none بذار و در reply از کاربر بپرس کدوم معامله. وصل‌کردن اشتباه فاکتور به مشتری غلط یک خطای مالی جدیه.
- list_invoices {}
- build_module {moduleName, entityLabel, fields:[{key,label,type}]} — حساس، بین ۳ تا ۶ فیلد پیشنهاد بده
- delete_module {moduleName} — حساس، برگشت‌ناپذیر (رکوردهای داخلش هم پاک می‌شن). اگه کاربر خواست ماژولی که از قبل هست رو «اصلاح/ویرایش» کنه با فیلدهای متفاوت، اول باید delete_module صدا بزنی، بعد در پیام بعدی (وقتی کاربر تایید کرد که پاک شد) build_module با فیلدهای جدید. این دو تا رو در یک پیام با هم صدا نزن.
- module_create_record {moduleName, values:{}}
- module_list_records {moduleName}
- publish_module {moduleName} — حساس
- install_module {moduleName} — حساس
- list_marketplace {}
- create_task {title, assigneeName?, dueInDays?} — یادآور/پیگیری؛ اگه assigneeName داده نشد یعنی برای خود کاربر است
- list_tasks {}
- delegate_task {taskTitle, assigneeName} — ارجاع وظیفه به یکی از اعضای تیم بالا
- generate_report {reportType} — یکی از: contacts | deals | invoices | tasks
- none {} — احوالپرسی یا درخواست نامفهوم

نکته مهم درباره «سرنخ» (Lead): در این سیستم «سرنخ» یک Deal با stage دقیقاً برابر «سرنخ» است — موجودیت جدا یا جدول جداگانه‌ای نیست. پس:
- «ثبت سرنخ» / «به‌عنوان سرنخ ثبت کن» ⇒ همیشه از create_deal استفاده کن، با title = نام شخص یا توضیح کوتاه (مثلاً نام فرد + رویداد)، contactName = نام و اگر شماره تلفن گفته شد آن را هم داخل contactName بنویس (مثلاً «آقای قنبری، ۰۹۱۷۹۹۹۱۲۳۴»)، و stage = «سرنخ». اگر کاربر جداگانه هم خواست مخاطب ثبت بشه، create_contact را هم اضافه کن، ولی خودِ سرنخ همیشه create_deal است.
- «لیست سرنخ‌ها» / «سرنخ‌ها رو نشون بده» ⇒ همیشه list_deals با params {"stage":"سرنخ"}.
این هماهنگی حیاتی است: اگر ثبت با create_contact انجام بشه ولی لیست‌گیری با list_deals باشه (یا برعکس)، کاربر فکر می‌کنه داده گم شده در حالی که فقط جای اشتباه نگاه شده.

نکته مهم درباره سوالات پیگیری (Follow-up): پیام‌های قبلی این گفتگو رو داری (تاریخچه). اگر کاربر سوالی پرسید که به چیزی اشاره داره که همین چند پیام قبل ساخته/گفته شده (مثلاً «ماژول کجاست؟» بعد از build_module، یا «چندتا شد؟» بعد از یک لیست)، حتماً از تاریخچه گفتگو + وضعیت فعلی داده (بالا) برای پاسخ استفاده کن — هیچ‌وقت حدس نزن یا ادعا نکن چیزی وجود نداره وقتی توی «وضعیت فعلی داده» می‌بینیش. اگر سوال صرفاً اطلاعاتی بود (نه یک عملیات جدید)، action را «none» بذار ولی در reply با اطلاعات واقعی و دقیق (از تاریخچه/داده بالا) جواب بده، نه با جمله کلی.

نکات حیاتی دیگر:
- هیچ مفهوم «فعال‌سازی جداگانه» برای ماژول‌ها وجود نداره. همین که build_module تایید بشه، ماژول بلافاصله ساخته و فعاله. اگر کاربر پرسید «فعالش کن» یا «آمادست؟» درباره ماژولی که در «ماژول‌های محلی» بالا می‌بینی، هرگز نگو «به زودی» یا «چند دقیقه صبر کنید» — بگو از همین الان فعال و آماده استفاده‌ست (action: none).
- اگر ماژولی که کاربر ازش حرف می‌زنه از قبل در «ماژول‌های محلی» بالا وجود داره، دوباره build_module صدا نزن (این باعث ساخت تکراری می‌شه). فقط توضیح بده که از قبل ساخته شده.
- اگر مطمئن نیستی کاربر می‌خواد عملیات جدیدی انجام بشه یا فقط داره درباره گذشته سوال می‌پرسه، action را «none» بذار و در reply دقیق توضیح بده؛ هیچ‌وقت به‌خاطر ابهام یک اکشن (به‌خصوص حساس مثل build_module) رو دوباره اجرا نکن.
- این سیستم هیچ پردازش پس‌زمینه یا صف کاری نداره — هر عملیات همون لحظه و کامل انجام می‌شه. هیچ‌وقت جمله‌هایی مثل «در حال بررسی...»، «لطفاً چند لحظه صبر کنید»، «به‌زودی انجام می‌شه» ننویس؛ یا همین الان با داده واقعی بالا (شامل رکوردهای ماژول‌ها) جواب قطعی بده، یا صادقانه بگو این اطلاعات رو نداری.
- هیچ‌وقت یک عملیات (فاکتور، بروزرسانی، ارجاع وظیفه و...) رو که مخصوص یک مشتری/معامله/مخاطب خاصه، به یک رکورد دیگه (حتی مشابه یا آخرین موردی که در گفتگو بوده) وصل نکن اگه رکورد درست پیدا نشد. یا اول رکورد درست رو بساز، یا از کاربر بپرس؛ هیچ‌وقت خودت جایگزین حدس نزن — این می‌تونه باعث خطای جدی (مثل فاکتور اشتباه) بشه.

فقط یک JSON خام برگردان، دقیقاً با این ساختار و بدون هیچ متن یا Markdown اضافه:
{"action": "...", "params": {...}, "reply": "یک جمله کوتاه و دوستانه فارسی، هماهنگ با شخصیتی که برات تعریف شد"}`;
}

// --- AI Gateway: routes to whichever provider is configured. ---
// AI_PROVIDER=anthropic|openai picks explicitly; if unset, we auto-detect
// from whichever API key is present (Anthropic takes priority if both are set).
function resolveProvider() {
  const explicit = (process.env.AI_PROVIDER || '').toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'mock';
}

async function callAI(systemPrompt, userText, history) {
  const provider = resolveProvider();
  if (provider === 'anthropic') return callAnthropic(systemPrompt, userText, history);
  if (provider === 'openai') return callOpenAI(systemPrompt, userText, history);
  return devMockParse(userText);
}

// history: array of {role: 'user'|'agent', text: string} — recent plain-text
// turns (NOT the structured action JSON, just what was said). Keeping only
// the human-readable reply text keeps the model focused on the conversation
// itself rather than re-parsing its own past JSON output.
function historyToMessages(history) {
  return (history || [])
    .slice(-8) // cap context size / cost
    .filter(m => m && m.text)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text).slice(0, 2000) }));
}

async function callAnthropic(systemPrompt, userText, history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.AGENTOS_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [...historyToMessages(history), { role: 'user', content: userText }]
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI Gateway error (Anthropic) ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  let raw = (textBlock ? textBlock.text : '{}').replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch { return { action: 'none', params: {}, reply: 'متوجه درخواست نشدم، می‌شه واضح‌تر بگی؟' }; }
}

async function callOpenAI(systemPrompt, userText, history) {
  const apiKey = process.env.OPENAI_API_KEY;
  // Configurable so this also works with OpenAI-compatible resellers/proxies
  // (e.g. GapGPT and similar Iranian services) that mirror the OpenAI API
  // shape on their own domain instead of api.openai.com — common because
  // OpenAI itself blocks access from Iran. Set OPENAI_BASE_URL to override.
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...historyToMessages(history),
      { role: 'user', content: userText }
    ]
  };
  // Some OpenAI-compatible resellers don't support response_format / reject
  // unknown models with it — allow disabling via env if it causes errors.
  if (process.env.OPENAI_JSON_MODE !== 'off') {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI Gateway error (OpenAI-compatible, ${baseUrl}) ${res.status}: ${errText}`);
  }
  const data = await res.json();
  let raw = (data.choices?.[0]?.message?.content) || '{}';
  raw = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch { return { action: 'none', params: {}, reply: 'متوجه درخواست نشدم، می‌شه واضح‌تر بگی؟' }; }
}

// --- DEV_MOCK: tiny offline heuristic, only used when no API key is set ---
function devMockParse(text) {
  const t = text.trim();
  if (/گزارش/.test(t) && /(اکسل|pdf|فایل|دانلود)/i.test(t)) {
    const type = /معامل/.test(t) ? 'deals' : /مخاطب/.test(t) ? 'contacts' : /فاکتور/.test(t) ? 'invoices' : /وظیفه|تسک/.test(t) ? 'tasks' : 'deals';
    return { action: 'generate_report', params: { reportType: type }, reply: '(DEV_MOCK) گزارش رو آماده کردم.' };
  }
  if (/وظیفه|یادآور|پیگیری/.test(t) && /ارجاع|بده به|واگذار/.test(t)) {
    const m = t.match(/به\s+([^\s,،]+)/);
    return { action: 'delegate_task', params: { taskTitle: t, assigneeName: m ? m[1] : '' }, reply: '(DEV_MOCK) این وظیفه نیاز به تایید نداره، ارجاع می‌دم.' };
  }
  if (/وظیفه|یادآور|پیگیری/.test(t) && /بساز|ثبت|ایجاد/.test(t)) {
    return { action: 'create_task', params: { title: t }, reply: '(DEV_MOCK) وظیفه ثبت شد.' };
  }
  if (/لیست.*وظیفه|وظیفه.*لیست|کارهای باز/.test(t)) return { action: 'list_tasks', params: {}, reply: '(DEV_MOCK) لیست وظایف باز.' };
  if (/فاکتور/.test(t)) {
    const m = t.match(/برای\s+(?:معامله\s+)?«?([^»,،]+)»?/);
    return { action: 'issue_invoice', params: { dealTitle: m ? m[1].trim() : '' }, reply: '(DEV_MOCK) این عملیات مالی نیاز به تایید داره.' };
  }
  if (/ماژول/.test(t) && /بساز/.test(t)) {
    const m = t.match(/ماژول\s+([^\s]+)/);
    return {
      action: 'build_module',
      params: {
        moduleName: m ? m[1] : 'ماژول جدید',
        entityLabel: m ? m[1] : 'رکورد',
        fields: [{ key: 'title', label: 'عنوان', type: 'text' }, { key: 'note', label: 'یادداشت', type: 'text' }]
      },
      reply: '(DEV_MOCK) این ماژول جدید نیاز به تایید Schema داره.'
    };
  }
  if (/حذف/.test(t) && /معامله/.test(t)) {
    const m = t.match(/معامله\s+«?([^»,،]+)»?/);
    return { action: 'delete_deal', params: { dealTitle: m ? m[1].trim() : '' }, reply: '(DEV_MOCK) این عملیات برگشت‌ناپذیره، نیاز به تایید داره.' };
  }
  if (/گزارش/.test(t)) return { action: 'report', params: {}, reply: '(DEV_MOCK) این گزارش خلاصه فروش توئه.' };
  if (/لیست.*مخاطب|مخاطب.*لیست/.test(t)) return { action: 'list_contacts', params: {}, reply: '(DEV_MOCK) لیست مخاطبین.' };
  if (/سرنخ/.test(t) && (/لیست|نشون بده|بیار/.test(t))) return { action: 'list_deals', params: { stage: 'سرنخ' }, reply: '(DEV_MOCK) لیست سرنخ‌ها.' };
  if (/سرنخ/.test(t) && (/ثبت|بساز|ایجاد/.test(t))) return { action: 'create_deal', params: { title: 'سرنخ جدید', stage: 'سرنخ' }, reply: '(DEV_MOCK) سرنخ ثبت شد.' };
  if (/لیست.*معامل|معامل.*لیست/.test(t)) return { action: 'list_deals', params: {}, reply: '(DEV_MOCK) لیست معاملات.' };
  const contactMatch = t.match(/مشتری جدید.*?(?:نام[:\s]*)?([^\d,،]+)[,،]?\s*(0?9\d{9})?/);
  if (/مشتری جدید|مخاطب جدید/.test(t)) {
    return { action: 'create_contact', params: { name: (contactMatch && contactMatch[1] || 'مخاطب جدید').trim(), phone: contactMatch && contactMatch[2] || '' }, reply: '(DEV_MOCK) مخاطب ثبت شد.' };
  }
  if (/معامله.*بساز|بساز.*معامله/.test(t)) {
    return { action: 'create_deal', params: { title: 'معامله نمونه' }, reply: '(DEV_MOCK) معامله ساخته شد.' };
  }
  return { action: 'none', params: {}, reply: '(DEV_MOCK) بدون کلید ANTHROPIC_API_KEY، فقط چند دستور ساده فارسی رو می‌فهمم.' };
}

function findDeal(tenantId, title) {
  if (!title) return null;
  return db.prepare('SELECT * FROM deals WHERE tenant_id = ? AND title LIKE ? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId, `%${title}%`);
}
function findContact(tenantId, name) {
  if (!name) return null;
  return db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId, `%${name}%`);
}
function findModule(tenantId, name) {
  if (!name) return null;
  return db.prepare('SELECT * FROM custom_modules WHERE tenant_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 1')
    .get(tenantId, `%${name}%`);
}
function findMarketItem(name) {
  if (!name) return null;
  return db.prepare('SELECT * FROM marketplace_modules WHERE name LIKE ? AND enabled = 1 ORDER BY created_at DESC LIMIT 1')
    .get(`%${name}%`);
}
function findTeamMember(tenantId, name) {
  if (!name) return null;
  return db.prepare(`SELECT * FROM users WHERE tenant_id = ? AND status = 'active' AND name LIKE ? LIMIT 1`)
    .get(tenantId, `%${name}%`);
}
function findTaskByTitle(tenantId, title) {
  if (!title) return null;
  return db.prepare(`SELECT * FROM tasks WHERE tenant_id = ? AND title LIKE ? ORDER BY created_at DESC LIMIT 1`)
    .get(tenantId, `%${title}%`);
}

function audit(tenantId, actorType, actorId, action, entity, detail) {
  db.prepare(`INSERT INTO audit_logs (id, tenant_id, actor_type, actor_id, action, entity, detail_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid(), tenantId, actorType, actorId || null, action, entity || null, JSON.stringify(detail || {}), now());
}

// Executes a NON-sensitive or an approved action against the real DB.
// Returns { result } describing what happened, for the API response.
function executeAction(tenantId, userId, action, params) {
  const t = now();
  switch (action) {
    case 'create_contact': {
      const { data } = dispatch({ tenantId, userId, role: 'agent' }, 'contact.created', params);
      audit(tenantId, 'agent', userId, 'create_contact', 'contact:' + data.id, params);
      return { type: 'contact', data };
    }
    case 'create_deal': {
      const id = uid();
      const stage = STAGES.includes(params.stage) ? params.stage : 'سرنخ';
      db.prepare('INSERT INTO deals (id, tenant_id, title, contact_name, amount, stage, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, tenantId, params.title || 'معامله جدید', params.contactName || '', params.amount != null ? Number(params.amount) : null, stage, userId, t, t);
      audit(tenantId, 'agent', userId, 'create_deal', 'deal:' + id, params);
      return { type: 'deal', data: db.prepare('SELECT * FROM deals WHERE id = ?').get(id) };
    }
    case 'update_deal_stage': {
      const deal = findDeal(tenantId, params.dealTitle);
      if (!deal || !STAGES.includes(params.newStage)) return null;
      db.prepare('UPDATE deals SET stage = ?, updated_at = ? WHERE id = ?').run(params.newStage, t, deal.id);
      audit(tenantId, 'agent', userId, 'update_deal_stage', 'deal:' + deal.id, params);
      return { type: 'deal', data: db.prepare('SELECT * FROM deals WHERE id = ?').get(deal.id) };
    }
    case 'delete_deal': {
      const deal = findDeal(tenantId, params.dealTitle);
      if (!deal) return null;
      db.prepare('DELETE FROM deals WHERE id = ?').run(deal.id);
      audit(tenantId, 'agent', userId, 'delete_deal', 'deal:' + deal.id, params);
      return { type: 'deleted', data: { label: deal.title } };
    }
    case 'delete_contact': {
      const c = findContact(tenantId, params.name);
      if (!c) return null;
      db.prepare('DELETE FROM contacts WHERE id = ?').run(c.id);
      audit(tenantId, 'agent', userId, 'delete_contact', 'contact:' + c.id, params);
      return { type: 'deleted', data: { label: c.name } };
    }
    case 'issue_invoice': {
      const deal = findDeal(tenantId, params.dealTitle);
      const amount = params.amount != null ? Number(params.amount) : (deal ? deal.amount : null);
      const id = uid();
      db.prepare('INSERT INTO invoices (id, tenant_id, deal_title, amount, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, tenantId, deal ? deal.title : (params.dealTitle || 'نامشخص'), amount, userId, t);
      audit(tenantId, 'agent', userId, 'issue_invoice', 'invoice:' + id, params);
      return { type: 'invoice', data: db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) };
    }
    case 'list_invoices':
      return { type: 'invoices_table', data: db.prepare('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) };
    case 'build_module': {
      const tenant = db.prepare('SELECT plan_key FROM tenants WHERE id = ?').get(tenantId);
      const plan = db.prepare('SELECT modules_limit FROM plans WHERE key = ?').get(tenant.plan_key);
      if (plan && plan.modules_limit != null) {
        const count = db.prepare('SELECT COUNT(*) c FROM custom_modules WHERE tenant_id = ?').get(tenantId).c;
        if (count >= plan.modules_limit) return { type: 'plan_limit', data: { limit: plan.modules_limit, feature: 'modules' } };
      }
      const fields = Array.isArray(params.fields) && params.fields.length ? params.fields : [{ key: 'note', label: 'یادداشت', type: 'text' }];
      const id = uid();
      db.prepare('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, tenantId, params.moduleName || 'ماژول جدید', params.entityLabel || params.moduleName || 'رکورد', JSON.stringify(fields), userId, t);
      audit(tenantId, 'agent', userId, 'build_module', 'module:' + id, params);
      return { type: 'module_created', data: db.prepare('SELECT * FROM custom_modules WHERE id = ?').get(id) };
    }
    case 'delete_module': {
      const mod = findModule(tenantId, params.moduleName);
      if (!mod) return null;
      db.prepare('DELETE FROM module_records WHERE module_id = ?').run(mod.id);
      db.prepare('DELETE FROM custom_modules WHERE id = ?').run(mod.id);
      audit(tenantId, 'agent', userId, 'delete_module', 'module:' + mod.id, params);
      return { type: 'deleted', data: { label: mod.name } };
    }
    case 'module_create_record': {
      const mod = findModule(tenantId, params.moduleName);
      if (!mod) return null;
      const id = uid();
      db.prepare('INSERT INTO module_records (id, module_id, tenant_id, values_json, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, mod.id, tenantId, JSON.stringify(params.values || {}), userId, t);
      audit(tenantId, 'agent', userId, 'module_create_record', 'module_record:' + id, params);
      return { type: 'module_record', data: { module: mod, record: db.prepare('SELECT * FROM module_records WHERE id = ?').get(id) } };
    }
    case 'module_list_records': {
      const mod = findModule(tenantId, params.moduleName);
      if (!mod) return null;
      const records = db.prepare('SELECT * FROM module_records WHERE module_id = ? ORDER BY created_at DESC').all(mod.id);
      return { type: 'module_records_table', data: { module: mod, records } };
    }
    case 'publish_module': {
      const mod = findModule(tenantId, params.moduleName);
      if (!mod) return null;
      const existing = db.prepare('SELECT * FROM marketplace_modules WHERE name = ? AND published_by_tenant = ?').get(mod.name, tenantId);
      if (existing) {
        db.prepare('UPDATE marketplace_modules SET fields_json = ? WHERE id = ?').run(mod.fields_json, existing.id);
        audit(tenantId, 'agent', userId, 'publish_module', 'marketplace:' + existing.id, params);
        return { type: 'module_published', data: db.prepare('SELECT * FROM marketplace_modules WHERE id = ?').get(existing.id) };
      }
      const id = uid();
      db.prepare('INSERT INTO marketplace_modules (id, name, entity_label, fields_json, published_by_tenant, installs, created_at) VALUES (?,?,?,?,?,0,?)')
        .run(id, mod.name, mod.entity_label, mod.fields_json, tenantId, t);
      audit(tenantId, 'agent', userId, 'publish_module', 'marketplace:' + id, params);
      return { type: 'module_published', data: db.prepare('SELECT * FROM marketplace_modules WHERE id = ?').get(id) };
    }
    case 'install_module': {
      const item = findMarketItem(params.moduleName);
      if (!item) return null;
      const id = uid();
      db.prepare('INSERT INTO custom_modules (id, tenant_id, name, entity_label, fields_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, tenantId, item.name, item.entity_label, item.fields_json, userId, t);
      db.prepare('UPDATE marketplace_modules SET installs = installs + 1 WHERE id = ?').run(item.id);
      audit(tenantId, 'agent', userId, 'install_module', 'module:' + id, params);
      return { type: 'module_created', data: db.prepare('SELECT * FROM custom_modules WHERE id = ?').get(id) };
    }
    case 'list_marketplace':
      return { type: 'marketplace_table', data: db.prepare('SELECT * FROM marketplace_modules WHERE enabled = 1 ORDER BY created_at DESC').all() };
    case 'create_task': {
      const assignee = params.assigneeName ? findTeamMember(tenantId, params.assigneeName) : null;
      const dueAt = params.dueInDays != null ? t + Number(params.dueInDays) * 86400000 : null;
      const id = uid();
      db.prepare(`INSERT INTO tasks (id, tenant_id, title, description, assignee_id, created_by, due_at, status, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, tenantId, params.title || 'وظیفه جدید', '', (assignee ? assignee.id : userId), userId, dueAt, 'open', t, t);
      audit(tenantId, 'agent', userId, 'create_task', 'task:' + id, params);
      const row = db.prepare('SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?').get(id);
      return { type: 'task', data: row };
    }
    case 'list_tasks': {
      const rows = db.prepare(`
        SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = ? AND t.status = 'open' ORDER BY (t.due_at IS NULL), t.due_at ASC LIMIT 20`).all(tenantId);
      return { type: 'tasks_table', data: rows };
    }
    case 'delegate_task': {
      const task = findTaskByTitle(tenantId, params.taskTitle);
      const assignee = findTeamMember(tenantId, params.assigneeName);
      if (!task || !assignee) return null;
      db.prepare('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?').run(assignee.id, t, task.id);
      audit(tenantId, 'agent', userId, 'delegate_task', 'task:' + task.id, params);
      const row = db.prepare('SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?').get(task.id);
      return { type: 'task', data: row };
    }
    case 'generate_report': {
      const type = ['contacts', 'deals', 'invoices', 'tasks'].includes(params.reportType) ? params.reportType : 'deals';
      let columns, rows;
      if (type === 'contacts') {
        columns = ['name', 'phone', 'company'];
        rows = db.prepare('SELECT name, phone, company FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
      } else if (type === 'deals') {
        columns = ['title', 'contact_name', 'amount', 'stage'];
        rows = db.prepare('SELECT title, contact_name, amount, stage FROM deals WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
      } else if (type === 'invoices') {
        columns = ['deal_title', 'amount'];
        rows = db.prepare('SELECT deal_title, amount FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
      } else {
        columns = ['title', 'assignee_name', 'status', 'due_at'];
        rows = db.prepare('SELECT t.title, u.name as assignee_name, t.status, t.due_at FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = ? ORDER BY t.created_at DESC').all(tenantId);
      }
      audit(tenantId, 'agent', userId, 'generate_report', 'report:' + type, { reportType: type });
      return { type: 'report_data', data: { reportType: type, columns, rows } };
    }
    case 'list_contacts':
      return { type: 'contacts_table', data: db.prepare('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) };
    case 'list_deals': {
      const rows = params.stage && STAGES.includes(params.stage)
        ? db.prepare('SELECT * FROM deals WHERE tenant_id = ? AND stage = ? ORDER BY created_at DESC').all(tenantId, params.stage)
        : db.prepare('SELECT * FROM deals WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
      return { type: 'deals_table', data: rows };
    }
    case 'report': {
      const openDeals = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) v FROM deals WHERE tenant_id = ? AND stage NOT IN ('برنده','ازدست‌رفته')`).get(tenantId);
      const won = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM deals WHERE tenant_id = ? AND stage = 'برنده'`).get(tenantId);
      const contactCount = db.prepare('SELECT COUNT(*) c FROM contacts WHERE tenant_id = ?').get(tenantId).c;
      return { type: 'report', data: { totalContacts: contactCount, openDeals: openDeals.c, pipelineValue: openDeals.v, wonValue: won.v } };
    }
    default:
      return null;
  }
}

// Main entrypoint used by the API layer.
async function act(tenantId, userId, text, history) {
  const user = db.prepare('SELECT agent_name, agent_persona FROM users WHERE id = ?').get(userId);
  const agentName = (user && user.agent_name) || 'Agent';
  const agentPersona = (user && user.agent_persona) || '';
  const systemPrompt = buildSystemPrompt(tenantId, agentName, agentPersona);
  const parsed = await callAI(systemPrompt, text, history);
  const action = parsed.action || 'none';
  const domain = DOMAIN_OF[action] || 'none';
  const params = parsed.params || {};
  const reply = parsed.reply || '';

  if (SENSITIVE_ACTIONS.has(action)) {
    // Code-level dedup guard for build_module: don't rely solely on the model
    // following prompt instructions to avoid duplicates — enforce it here.
    if (action === 'build_module' && params.moduleName) {
      const existing = findModule(tenantId, params.moduleName);
      if (existing) {
        return {
          requiresApproval: false, action, domain,
          params, reply: `ماژول «${existing.name}» از قبل ساخته و فعال شده — نیازی به ساخت دوباره نیست.`,
          result: { type: 'module_created', data: existing }
        };
      }
    }
    const id = uid();
    db.prepare(`INSERT INTO pending_actions (id, tenant_id, user_id, action, domain, params_json, reply, status, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, tenantId, userId, action, domain, JSON.stringify(params), reply, 'pending', now());
    return { requiresApproval: true, pendingId: id, action, domain, params, reply };
  }

  const result = executeAction(tenantId, userId, action, params);
  return { requiresApproval: false, action, domain, params, reply, result };
}

function resolvePending(tenantId, userId, pendingId, approve) {
  const pending = db.prepare('SELECT * FROM pending_actions WHERE id = ? AND tenant_id = ?').get(pendingId, tenantId);
  if (!pending) return { error: 'not_found' };
  if (pending.status !== 'pending') return { error: 'already_resolved', status: pending.status };

  if (!approve) {
    db.prepare('UPDATE pending_actions SET status = ?, resolved_at = ? WHERE id = ?').run('rejected', now(), pendingId);
    audit(tenantId, 'user', userId, 'reject_pending_action', pending.action, JSON.parse(pending.params_json));
    return { status: 'rejected' };
  }

  const params = JSON.parse(pending.params_json);
  const result = executeAction(tenantId, userId, pending.action, params);
  db.prepare('UPDATE pending_actions SET status = ?, resolved_at = ? WHERE id = ?').run(result ? 'approved' : 'failed', now(), pendingId);
  audit(tenantId, 'user', userId, 'approve_pending_action', pending.action, params);
  return { status: result ? 'approved' : 'failed', result };
}

module.exports = { act, resolvePending, executeAction, SENSITIVE_ACTIONS, audit, resolveProvider };
