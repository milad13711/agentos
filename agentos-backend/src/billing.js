// billing.js — real Zarinpal payment gateway integration.
//
// Docs: https://docs.zarinpal.com/paymentGateway/
// Two calls: PaymentRequest (get a redirect URL) and PaymentVerification
// (confirm the payment actually succeeded before granting the plan).
//
// Zarinpal amounts are in Rial; our prices are stored in Toman, so we
// multiply by 10 when calling Zarinpal and keep Toman everywhere else.

const { db, uid, now } = require('./db');

function zarinpalBase() {
  // Sandbox lets you test the full flow with a fake merchant id before
  // your real Zarinpal account is approved — see README "درگاه پرداخت".
  return process.env.ZARINPAL_SANDBOX === '1'
    ? 'https://sandbox.zarinpal.com/pg/v4/payment'
    : 'https://payment.zarinpal.com/pg/v4/payment';
}
function zarinpalStartPayUrl(authority) {
  const host = process.env.ZARINPAL_SANDBOX === '1' ? 'sandbox.zarinpal.com' : 'payment.zarinpal.com';
  return `https://${host}/pg/StartPay/${authority}`;
}

async function createPaymentRequest({ tenantId, userId, planKey, billingCycle, email }) {
  const merchantId = process.env.ZARINPAL_MERCHANT_ID;
  const publicAppUrl = process.env.PUBLIC_APP_URL; // e.g. https://exirsms.ir — must be the real public domain
  if (!merchantId) throw new Error('ZARINPAL_MERCHANT_ID تنظیم نشده — در .env بک‌اند اضافه کن.');
  if (!publicAppUrl) throw new Error('PUBLIC_APP_URL تنظیم نشده — باید دامنه عمومی واقعی باشه (مثل https://exirsms.ir).');

  const plan = await db.get('SELECT * FROM plans WHERE key = ?', [planKey]);
  if (!plan) throw new Error('پلن نامعتبر است.');
  const amountToman = billingCycle === 'yearly' ? plan.price_yearly_toman : plan.price_monthly_toman;
  if (!amountToman || amountToman <= 0) throw new Error('این پلن رایگانه یا قیمتش تنظیم نشده — نیازی به پرداخت نداره.');

  const callbackUrl = `${publicAppUrl.replace(/\/$/, '')}/api/billing/callback`;

  const res = await fetch(`${zarinpalBase()}/request.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      merchant_id: merchantId,
      amount: Math.round(amountToman * 10), // Toman -> Rial
      callback_url: callbackUrl,
      description: `اشتراک پلن ${plan.name} (${billingCycle === 'yearly' ? 'سالانه' : 'ماهانه'}) — AgentOS`,
      metadata: email ? { email } : undefined
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.data || data.data.code !== 100) {
    const msg = (data && (data.errors?.message || data.data?.message)) || `HTTP ${res.status}`;
    throw new Error(`درخواست پرداخت زرین‌پال رد شد: ${msg}`);
  }

  const authority = data.data.authority;
  const id = uid();
  await db.run(`INSERT INTO subscription_payments
              (id, tenant_id, plan_key, billing_cycle, amount_toman, authority, status, created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
    [id, tenantId, planKey, billingCycle, amountToman, authority, 'pending', now()]);

  return { redirectUrl: zarinpalStartPayUrl(authority), authority, paymentId: id };
}

async function verifyPayment({ tenantId, authority, status }) {
  const payment = await db.get('SELECT * FROM subscription_payments WHERE authority = ? AND tenant_id = ?', [authority, tenantId]);
  if (!payment) return { ok: false, error: 'پرداخت مربوطه پیدا نشد.' };
  if (payment.status === 'paid') return { ok: true, alreadyProcessed: true, payment };

  if (status !== 'OK') {
    await db.run(`UPDATE subscription_payments SET status = 'failed' WHERE id = ?`, [payment.id]);
    return { ok: false, error: 'پرداخت توسط کاربر لغو یا ناموفق بود.' };
  }

  const merchantId = process.env.ZARINPAL_MERCHANT_ID;
  const res = await fetch(`${zarinpalBase()}/verify.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      merchant_id: merchantId,
      amount: Math.round(payment.amount_toman * 10),
      authority
    })
  });
  const data = await res.json().catch(() => null);
  const code = data?.data?.code;

  if (code === 100 || code === 101) {
    const refId = data.data.ref_id || null;
    await db.run(`UPDATE subscription_payments SET status = 'paid', ref_id = ?, paid_at = ? WHERE id = ?`,
      [refId ? String(refId) : null, now(), payment.id]);
    await db.run('UPDATE tenants SET plan_key = ? WHERE id = ?', [payment.plan_key, tenantId]);
    // Audit logging is the caller's job now (server.js has the authenticated
    // userId; billing.js doesn't) — see 'subscription_paid' in the
    // /api/billing/verify route. This also keeps billing.js from writing to
    // the events table directly (single choke point stays in agent.js's audit()).
    return { ok: true, refId, planKey: payment.plan_key, amountToman: payment.amount_toman };
  }

  await db.run(`UPDATE subscription_payments SET status = 'failed' WHERE id = ?`, [payment.id]);
  const msg = (data && (data.errors?.message || data.data?.message)) || `کد ${code}`;
  return { ok: false, error: `تایید پرداخت ناموفق: ${msg}` };
}

module.exports = { createPaymentRequest, verifyPayment };
