'use client';

import { useEffect, useState } from 'react';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

export default function SettingsPage() {
  const [agentName, setAgentName] = useState('');
  const [agentPersona, setAgentPersona] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [telegramLinked, setTelegramLinked] = useState(false);
  const [linkCode, setLinkCode] = useState<{ code: string; botUsername: string | null; deepLink: string | null } | null>(null);
  const [telegramMsg, setTelegramMsg] = useState<string | null>(null);

  function loadMe() {
    return api('me').then((me) => {
      setAgentName(me.user.agent_name || '');
      setAgentPersona(me.user.agent_persona || '');
      setTelegramLinked(!!me.user.telegramLinked);
    });
  }
  useEffect(() => {
    loadMe();
  }, []);

  async function save() {
    setMsg(null);
    try {
      await api('me/agent', { method: 'PATCH', body: JSON.stringify({ agentName, agentPersona }) });
      setMsg({ ok: true, text: '✓ ذخیره شد' });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message + ' — شخصی‌سازی شخصیت Agent از پلن Starter به بالا فعال می‌شه.' });
    }
  }

  async function requestTelegramCode() {
    setTelegramMsg(null);
    setLinkCode(null);
    try {
      const res = await api('me/telegram/link-code', { method: 'POST' });
      setLinkCode(res);
    } catch (e: any) {
      setTelegramMsg('خطا: ' + e.message);
    }
  }

  async function unlinkTelegram() {
    setTelegramMsg(null);
    try {
      await api('me/telegram', { method: 'DELETE' });
      setTelegramLinked(false);
      setLinkCode(null);
      setTelegramMsg('اتصال تلگرام قطع شد.');
    } catch (e: any) {
      setTelegramMsg('خطا: ' + e.message);
    }
  }

  return (
    <div className="p-4 md:p-6 overflow-y-auto overflow-x-hidden flex flex-col gap-5">
      <h1 className="font-extrabold text-sm">شخصی‌سازی Agent شخصی من</h1>
      <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 max-w-md">
        <h3 className="font-bold text-sm mb-3">نام و شخصیت Agent</h3>
        <label className="block text-[11px] text-[var(--text-3)] mb-1">اسم Agent</label>
        <input
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="مثلاً: آریا"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none mb-3"
        />
        <label className="block text-[11px] text-[var(--text-3)] mb-1">شخصیت (چطور باهات صحبت کنه؟)</label>
        <textarea
          value={agentPersona}
          onChange={(e) => setAgentPersona(e.target.value)}
          rows={3}
          placeholder="مثلاً: رسمی و خیلی مختصر صحبت کن"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none mb-3"
        />
        <button onClick={save} className="bg-[var(--primary)] text-[#1a1400] font-bold text-sm rounded-lg px-4 py-2">
          ذخیره
        </button>
        {msg && <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${msg.ok ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'text-[var(--danger)]'}`}>{msg.text}</div>}
      </div>

      <div className="bg-[var(--surface)] border border-[var(--border-soft)] rounded-2xl p-4 max-w-md">
        <h3 className="font-bold text-sm mb-1">اتصال تلگرام</h3>
        <p className="text-[11px] text-[var(--text-3)] mb-3">
          بعد از اتصال، هرچی تو تلگرام به Agent بگی دقیقاً مثل چت داخل AgentOS اجرا می‌شه — با همون تایید برای عملیات حساس.
        </p>

        {telegramLinked ? (
          <>
            <div className="text-xs text-[var(--success)] bg-[var(--success-soft)] rounded-lg px-3 py-2 mb-3">✓ حساب شما به تلگرام وصله</div>
            <button onClick={unlinkTelegram} className="bg-[var(--surface-3)] text-[var(--danger)] font-bold text-xs rounded-lg px-3.5 py-2">
              قطع اتصال
            </button>
          </>
        ) : (
          <>
            {!linkCode ? (
              <button onClick={requestTelegramCode} className="bg-[var(--primary)] text-[#1a1400] font-bold text-sm rounded-lg px-4 py-2">
                گرفتن کد اتصال
              </button>
            ) : (
              <div className="text-xs text-[var(--text-2)]">
                <p className="mb-2">
                  ۱. تو تلگرام {linkCode.botUsername ? <>ربات <b>@{linkCode.botUsername}</b> رو باز کن</> : 'ربات AgentOS رو باز کن'} و این پیام رو بفرست:
                </p>
                <div dir="ltr" className="text-center font-mono text-sm bg-[var(--surface-2)] border border-[var(--border)] rounded-lg py-2 mb-2 select-all">
                  /start {linkCode.code}
                </div>
                {linkCode.deepLink && (
                  <a href={linkCode.deepLink} target="_blank" rel="noreferrer" className="block text-center bg-[var(--primary)] text-[#1a1400] font-bold text-xs rounded-lg px-3.5 py-2 mb-2">
                    باز کردن مستقیم در تلگرام
                  </a>
                )}
                <p className="text-[10.5px] text-[var(--text-3)] mb-2">این کد تا ۱۰ دقیقه دیگه معتبره.</p>
                <button onClick={loadMe} className="text-[10.5px] text-[var(--primary)] font-bold">
                  وصل شدم — بررسی کن
                </button>
              </div>
            )}
          </>
        )}
        {telegramMsg && <div className="mt-3 text-xs text-[var(--text-3)]">{telegramMsg}</div>}
      </div>
    </div>
  );
}
