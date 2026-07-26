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
const { dispatch, resolveEvent, STAGES, findDeal, findContact, findModule, findMarketItem, findTeamMember } = require('./actions');

const SENSITIVE_ACTIONS = new Set([
  'issue_invoice', 'delete_deal', 'delete_contact',
  'build_module', 'delete_module', 'publish_module', 'install_module'
]);

// Maps the Agent's action vocabulary to actions.js event types, only for
// sensitive actions (the non-sensitive ones already call dispatch() inline
// in executeAction below with their event type hardcoded).
const SENSITIVE_ACTION_TYPE = {
  delete_deal: 'deal.deleted',
  delete_contact: 'contact.deleted',
  issue_invoice: 'invoice.issued',
  build_module: 'module.created',
  delete_module: 'module.deleted',
  publish_module: 'marketplace.published',
  install_module: 'module.installed',
};
// event type -> the `result.type` label the frontends already expect
// (predates events; kept stable so no frontend code needs to change).
const RESULT_TYPE_OF = {
  'deal.deleted': 'deleted',
  'contact.deleted': 'deleted',
  'invoice.issued': 'invoice',
  'module.created': 'module_created',
  'module.deleted': 'deleted',
  'marketplace.published': 'module_published',
  'module.installed': 'module_created',
};
function toLegacyResult(eventType, data) {
  if (!data) return null;
  // module.created's plan-limit case and module.installed's duplicate-install
  // case are both already shaped as {type, data} by dispatch()'s skipEvent path.
  if (data.type === 'plan_limit' || data.type === 'already_installed') return data;
  return { type: RESULT_TYPE_OF[eventType], data };
}
const DOMAIN_OF = {
  create_contact: 'sales', create_deal: 'sales', update_deal_stage: 'sales',
  delete_deal: 'sales', delete_contact: 'sales', list_contacts: 'sales',
  list_deals: 'sales', report: 'sales',
  issue_invoice: 'finance', list_invoices: 'finance',
  build_module: 'builder', delete_module: 'builder', module_create_record: 'builder', module_list_records: 'builder',
  publish_module: 'builder', install_module: 'builder', list_marketplace: 'builder',
  create_task: 'team', list_tasks: 'team', delegate_task: 'team',
  log_interaction: 'sales', message_contact: 'sales',
  generate_report: 'reports',
  none: 'none'
};

async function dataSnapshot(tenantId) {
  const contactCount = (await db.get('SELECT COUNT(*) c FROM contacts WHERE tenant_id = ?', [tenantId])).c;
  const dealCount = (await db.get('SELECT COUNT(*) c FROM deals WHERE tenant_id = ?', [tenantId])).c;
  const recentDeals = await db.all('SELECT title, contact_name, amount, stage FROM deals WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10', [tenantId]);
  const recentContacts = await db.all('SELECT name, phone, company FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10', [tenantId]);
  const modules = await db.all('SELECT id, name, fields_json FROM custom_modules WHERE tenant_id = ?', [tenantId]);
  const marketItems = await db.all('SELECT name, fields_json, published_by_tenant FROM marketplace_modules WHERE enabled = TRUE');
  const teamMembers = await db.all(`SELECT name FROM users WHERE tenant_id = ? AND status = 'active'`, [tenantId]);

  const modulesDesc = modules.length
    ? (await Promise.all(modules.map(async m => {
        const fields = JSON.parse(m.fields_json);
        const records = await db.all('SELECT values_json FROM module_records WHERE module_id = ? ORDER BY created_at DESC LIMIT 8', [m.id]);
        const recordCount = (await db.get('SELECT COUNT(*) c FROM module_records WHERE module_id = ?', [m.id])).c;
        const recordsDesc = records.length
          ? records.map(r => {
              const v = JSON.parse(r.values_json || '{}');
              return '{' + fields.map(f => `${f.key}=${v[f.key] ?? '—'}`).join('، ') + '}';
            }).join(' | ')
          : 'هیچ رکوردی ثبت نشده';
        return `«${m.name}» (فیلدها: ${fields.map(f => f.key).join('، ')}) — ${recordCount} رکورد ثبت‌شده — رکوردهای اخیر: ${recordsDesc}`;
      }))).join('\n  ')
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

async function buildSystemPrompt(tenantId, agentName, agentPersona) {
  const personaLine = agentPersona
    ? `نام تو «${agentName}» است و باید با این شخصیت پاسخ بدی: ${agentPersona}`
    : `نام تو «${agentName}» است.`;
  return `تو ${personaLine}
تو Orchestrator Agent در سیستم AgentOS هستی و درخواست فارسی کاربر را به یک اکشن ساختاریافته تبدیل می‌کنی.

وضعیت فعلی داده این Tenant:
${await dataSnapshot(tenantId)}

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
- create_task {title, assigneeName?, dueInDays?, dueHour?, dueMinute?} — یادآور/پیگیری؛ اگه assigneeName داده نشد یعنی برای خود کاربر است. اگه کاربر ساعت مشخصی گفت (مثلاً «ساعت ۵ بعدازظهر»، «ساعت ۹ صبح فردا») حتماً dueHour (۰ تا ۲۳) و در صورت نیاز dueMinute رو هم پر کن — این یادآور دقیقاً همون ساعت از طریق تلگرام/Push ارسال می‌شه، نه فقط همون روز. اگه فقط روز گفته شد بدون ساعت مشخص، فقط dueInDays کافیه.
- list_tasks {}
- delegate_task {taskTitle, assigneeName} — ارجاع وظیفه به یکی از اعضای تیم بالا
- log_interaction {contactName? یا dealTitle?, note} — هر بار که کاربر گزارش می‌ده با یک مشتری/سرنخ ارتباط گرفته (تماس، جلسه، پیام و...)، این یادداشت رو روی همون مخاطب/سرنخ (دقیقاً یکی از این دو — contactName برای مخاطب، dealTitle برای سرنخ/معامله) ثبت کن تا تاریخچه‌ش نگه داشته بشه. اگه مخاطب/سرنخ پیدا نشد، action رو none بذار و در reply بگو کدوم رو دقیق‌تر بگه.
- message_contact {contactName, message} — ارسال پیام مستقیم به یک مخاطب/مشتری خاص از طریق بات تلگرام (نه به اعضای تیم — این فقط برای مشتری/سرنخ بیرونیه). فقط وقتی مخاطب از قبل تلگرامش به AgentOS وصل شده کار می‌کنه؛ اگه وصل نبود، در reply همین رو بگو (باید از صفحه مخاطبین لینک اتصال گرفته بشه).
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

// AI Gateway calls previously had no timeout — a slow/unresponsive upstream
// (seen in practice with GapGPT) would leave the request hanging forever
// with no error, which the frontend showed as a stuck "در حال پردازش...".
// 25s gives a real model response plenty of room while still failing loudly.
const AI_GATEWAY_TIMEOUT_MS = 25_000;
function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function callAnthropic(systemPrompt, userText, history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { signal, cancel } = withTimeout(AI_GATEWAY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
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
      }),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`AI Gateway timeout (Anthropic) after ${AI_GATEWAY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    cancel();
  }
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

  const { signal, cancel } = withTimeout(AI_GATEWAY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`AI Gateway timeout (OpenAI-compatible, ${baseUrl}) after ${AI_GATEWAY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    cancel();
  }
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

// findDeal/findContact/findModule/findMarketItem/findTeamMember now live in
// actions.js (single source, shared with the REST dispatch path). Only the
// fuzzy-lookup helpers actions.js doesn't need yet stay here.
async function findTaskByTitle(tenantId, title) {
  if (!title) return null;
  return db.get(`SELECT * FROM tasks WHERE tenant_id = ? AND title LIKE ? ORDER BY created_at DESC LIMIT 1`,
    [tenantId, `%${title}%`]);
}

// General-purpose audit trail, now backed by `events` (single source of
// truth — see docs/phase1-event-schema-agent-roles.md). Used for business
// events that aren't a registry-dispatched CRUD action (team/billing/admin
// changes, approval decisions, etc). Registry actions log their own event
// inside dispatch()/resolveEvent(); callers there should NOT also call
// audit() for the same fact — that would just re-create the audit_logs
// dual-write problem this migration exists to remove.
async function audit(tenantId, actorType, actorId, action, entity, detail) {
  const [entityType, entityId] = entity ? entity.split(':') : [null, null];
  await db.run(`INSERT INTO events (id, tenant_id, type, actor_type, actor_id, actor_role, entity_type, entity_id, payload_json, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`,
    [uid(), tenantId, action, actorType, actorId || null, actorType, entityType || null, entityId || null, JSON.stringify(detail || {}), now()]);
}

// Executes a NON-sensitive or an approved action against the real DB.
// Returns { result } describing what happened, for the API response.
async function executeAction(tenantId, userId, action, params) {
  const t = now();
  switch (action) {
    case 'create_contact': {
      const { data } = await dispatch({ tenantId, userId, role: 'agent' }, 'contact.created', params);
      return { type: 'contact', data };
    }
    case 'create_deal': {
      const { data } = await dispatch({ tenantId, userId, role: 'agent' }, 'deal.created', params);
      return { type: 'deal', data };
    }
    case 'update_deal_stage': {
      const { data } = await dispatch({ tenantId, userId, role: 'agent' }, 'deal.stage_changed', params);
      if (!data) return null;
      return { type: 'deal', data };
    }
    case 'list_invoices':
      return { type: 'invoices_table', data: await db.all('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]) };
    // delete_deal, delete_contact, issue_invoice, build_module, delete_module
    // are sensitive — they never reach executeAction() directly. act() sends
    // them through dispatch() (queues a pending_approval event); resolvePending()
    // applies them via resolveEvent() once approved. See SENSITIVE_ACTION_TYPE below.
    case 'module_create_record': {
      const { data } = await dispatch({ tenantId, userId, role: 'agent' }, 'module.record_created', params);
      if (!data) return null;
      return { type: 'module_record', data };
    }
    case 'module_list_records': {
      const mod = await findModule(tenantId, null, params.moduleName);
      if (!mod) return null;
      const records = await db.all('SELECT * FROM module_records WHERE module_id = ? ORDER BY created_at DESC', [mod.id]);
      return { type: 'module_records_table', data: { module: mod, records } };
    }
    case 'list_marketplace':
      return { type: 'marketplace_table', data: await db.all('SELECT * FROM marketplace_modules WHERE enabled = TRUE ORDER BY created_at DESC') };
    case 'create_task': {
      const { data } = await dispatch({ tenantId, userId, role: 'agent' }, 'task.created', params);
      return { type: 'task', data };
    }
    case 'list_tasks': {
      const rows = await db.all(`
        SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = ? AND t.status = 'open' ORDER BY (t.due_at IS NULL), t.due_at ASC LIMIT 20`, [tenantId]);
      return { type: 'tasks_table', data: rows };
    }
    case 'log_interaction': {
      const { data } = await dispatch({ tenantId, userId, role: 'agent' }, 'interaction.logged', params);
      if (!data) return null;
      return { type: 'interaction_logged', data };
    }
    case 'message_contact': {
      const { data } = await dispatch({ tenantId, userId, role: 'agent' }, 'contact.messaged', params);
      if (!data) return null;
      return data; // already shaped {type: 'message_sent'|'telegram_not_linked', data: {...}}
    }
    case 'delegate_task': {
      const task = await findTaskByTitle(tenantId, params.taskTitle);
      const assignee = await findTeamMember(tenantId, null, params.assigneeName);
      if (!task || !assignee) return null;
      await db.run('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?', [assignee.id, t, task.id]);
      await audit(tenantId, 'agent', userId, 'delegate_task', 'task:' + task.id, params);
      const row = await db.get('SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?', [task.id]);
      return { type: 'task', data: row };
    }
    case 'generate_report': {
      const type = ['contacts', 'deals', 'invoices', 'tasks'].includes(params.reportType) ? params.reportType : 'deals';
      let columns, rows;
      if (type === 'contacts') {
        columns = ['name', 'phone', 'company'];
        rows = await db.all('SELECT name, phone, company FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
      } else if (type === 'deals') {
        columns = ['title', 'contact_name', 'amount', 'stage'];
        rows = await db.all('SELECT title, contact_name, amount, stage FROM deals WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
      } else if (type === 'invoices') {
        columns = ['deal_title', 'amount'];
        rows = await db.all('SELECT deal_title, amount FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
      } else {
        columns = ['title', 'assignee_name', 'status', 'due_at'];
        rows = await db.all('SELECT t.title, u.name as assignee_name, t.status, t.due_at FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = ? ORDER BY t.created_at DESC', [tenantId]);
      }
      await audit(tenantId, 'agent', userId, 'generate_report', 'report:' + type, { reportType: type });
      return { type: 'report_data', data: { reportType: type, columns, rows } };
    }
    case 'list_contacts':
      return { type: 'contacts_table', data: await db.all('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]) };
    case 'list_deals': {
      const rows = params.stage && STAGES.includes(params.stage)
        ? await db.all('SELECT * FROM deals WHERE tenant_id = ? AND stage = ? ORDER BY created_at DESC', [tenantId, params.stage])
        : await db.all('SELECT * FROM deals WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
      return { type: 'deals_table', data: rows };
    }
    case 'report': {
      const openDeals = await db.get(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) v FROM deals WHERE tenant_id = ? AND stage NOT IN ('برنده','ازدست‌رفته')`, [tenantId]);
      const won = await db.get(`SELECT COALESCE(SUM(amount),0) v FROM deals WHERE tenant_id = ? AND stage = 'برنده'`, [tenantId]);
      const contactCount = (await db.get('SELECT COUNT(*) c FROM contacts WHERE tenant_id = ?', [tenantId])).c;
      return { type: 'report', data: { totalContacts: contactCount, openDeals: openDeals.c, pipelineValue: openDeals.v, wonValue: won.v } };
    }
    default:
      return null;
  }
}

// Main entrypoint used by the API layer.
async function act(tenantId, userId, text, history) {
  const user = await db.get('SELECT agent_name, agent_persona FROM users WHERE id = ?', [userId]);
  const agentName = (user && user.agent_name) || 'Agent';
  const agentPersona = (user && user.agent_persona) || '';
  const systemPrompt = await buildSystemPrompt(tenantId, agentName, agentPersona);
  const parsed = await callAI(systemPrompt, text, history);
  const action = parsed.action || 'none';
  const domain = DOMAIN_OF[action] || 'none';
  const params = parsed.params || {};
  const reply = parsed.reply || '';

  if (SENSITIVE_ACTIONS.has(action)) {
    // Code-level dedup guard for build_module: don't rely solely on the model
    // following prompt instructions to avoid duplicates — enforce it here.
    if (action === 'build_module' && params.moduleName) {
      const existing = await findModule(tenantId, null, params.moduleName);
      if (existing) {
        return {
          requiresApproval: false, action, domain,
          params, reply: `ماژول «${existing.name}» از قبل ساخته و فعال شده — نیازی به ساخت دوباره نیست.`,
          result: { type: 'module_created', data: existing }
        };
      }
    }
    const type = SENSITIVE_ACTION_TYPE[action];
    const { eventId } = await dispatch({ tenantId, userId, role: 'agent' }, type, params);
    return { requiresApproval: true, pendingId: eventId, action, domain, params, reply };
  }

  const result = await executeAction(tenantId, userId, action, params);
  return { requiresApproval: false, action, domain, params, reply, result };
}

// pendingId is an events.id (see actions.js — dispatch() queues sensitive
// actions there as status='pending_approval' instead of the old
// pending_actions table).
async function resolvePending(tenantId, userId, pendingId, approve) {
  const ev = await db.get('SELECT * FROM events WHERE id = ? AND tenant_id = ?', [pendingId, tenantId]);
  if (!ev) return { error: 'not_found' };
  if (ev.status !== 'pending_approval') return { error: 'already_resolved', status: ev.status };
  const params = JSON.parse(ev.payload_json);

  if (!approve) {
    await resolveEvent(tenantId, pendingId, false);
    await audit(tenantId, 'user', userId, 'reject_pending_action', ev.type, params);
    return { status: 'rejected' };
  }

  const outcome = await resolveEvent(tenantId, pendingId, true);
  await audit(tenantId, 'user', userId, 'approve_pending_action', ev.type, params);
  return { status: outcome.status, result: toLegacyResult(ev.type, outcome.data) };
}

module.exports = { act, resolvePending, executeAction, SENSITIVE_ACTIONS, audit, resolveProvider };
