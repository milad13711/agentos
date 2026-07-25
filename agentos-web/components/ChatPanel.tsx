'use client';

import { useEffect, useRef, useState } from 'react';

type Msg = {
  role: 'user' | 'agent';
  text: string;
  thinking?: boolean;
  pendingId?: string;
  action?: string;
  params?: any;
  resolved?: 'approved' | 'rejected' | null;
  result?: any;
};

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/proxy/${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'request_failed');
  return data;
}

// Keyed per-user, not a fixed key — localStorage is shared across the whole
// browser origin, so a fixed key leaked one account's chat history into
// whichever account next logged in on the same browser/device.
function chatStorageKey(userId: string) {
  return `agentos_chat_messages:${userId}`;
}

function esc(s: any) {
  return s === null || s === undefined ? '—' : String(s);
}

function ResultCard({ result }: { result: any }) {
  if (!result || !result.type) return null;
  const box = 'mt-1.5 border border-[var(--border)] border-r-[3px] border-r-[var(--primary)] bg-[var(--surface-2)] rounded-lg rounded-r-sm p-3 text-xs';
  const row = (label: string, value: any) => (
    <div className="flex justify-between py-0.5 text-[var(--text-2)]">
      <span className="text-[var(--text-3)]">{label}</span>
      <span>{esc(value)}</span>
    </div>
  );

  switch (result.type) {
    case 'contact':
      return (
        <div className={box}>
          <b>مخاطب جدید</b>
          {row('نام', result.data.name)}
          {row('تلفن', result.data.phone)}
          {result.data.company && row('شرکت', result.data.company)}
        </div>
      );
    case 'deal':
      return (
        <div className={box}>
          <b>معامله</b>
          {row('عنوان', result.data.title)}
          {row('مخاطب', result.data.contact_name)}
          {result.data.amount != null && row('مبلغ', result.data.amount)}
          {row('مرحله', result.data.stage)}
        </div>
      );
    case 'invoice':
      return (
        <div className={box}>
          <b>فاکتور صادر شد</b>
          {row('معامله', result.data.deal_title)}
          {row('مبلغ', result.data.amount)}
        </div>
      );
    case 'deleted':
      return (
        <div className="mt-1.5 border border-[var(--danger)]/30 border-r-[3px] border-r-[var(--danger)] bg-[var(--surface-2)] rounded-lg rounded-r-sm p-3 text-xs">
          🗑 «{result.data.label}» حذف شد
        </div>
      );
    case 'module_created':
      return (
        <div className={box}>
          <b>ماژول ساخته شد: {result.data.name}</b>
        </div>
      );
    case 'module_record':
      return (
        <div className={box}>
          <b>رکورد جدید در «{result.data.module?.name}»</b>
        </div>
      );
    case 'plan_limit':
      return (
        <div className="mt-1.5 border border-[var(--danger)]/30 border-r-[3px] border-r-[var(--danger)] bg-[var(--surface-2)] rounded-lg rounded-r-sm p-3 text-xs">
          سقف پلن فعلی برای «{result.data.feature}» ({result.data.limit}) پر شده — برای ادامه پلن رو ارتقا بده.
        </div>
      );
    case 'contacts_table':
    case 'deals_table':
    case 'invoices_table':
    case 'tasks_table':
    case 'marketplace_table': {
      const rows: any[] = Array.isArray(result.data) ? result.data : result.data?.records || [];
      if (!rows.length) return <div className={box}>موردی یافت نشد</div>;
      const cols = Object.keys(rows[0]).filter((k) => !['id', 'tenant_id', 'created_by', 'module_id', 'values_json', 'updated_at'].includes(k));
      const fmt = (col: string, val: any) => (col === 'created_at' || col === 'due_at' ? esc(val ? new Date(val).toLocaleDateString('fa-IR') : null) : esc(val));
      return (
        <div className={box}>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[280px] text-[11px]">
            <thead>
              <tr>{cols.map((c) => <th key={c} className="text-right text-[var(--text-3)] pb-1">{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r, idx) => (
                <tr key={idx}>{cols.map((c) => <td key={c} className="py-0.5">{fmt(c, r[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      );
    }
    case 'module_records_table': {
      // module_records rows store their real field data inside values_json —
      // parse it and show the module's actual fields, not raw row metadata.
      const mod = result.data?.module;
      const recordRows: any[] = result.data?.records || [];
      if (!mod || !recordRows.length) return <div className={box}>هنوز رکوردی ثبت نشده</div>;
      const fields = mod.fields || [];
      return (
        <div className={box}>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[280px] text-[11px]">
            <thead>
              <tr>{fields.map((f: any) => <th key={f.key} className="text-right text-[var(--text-3)] pb-1">{f.label}</th>)}</tr>
            </thead>
            <tbody>
              {recordRows.slice(0, 8).map((r, idx) => {
                const values = JSON.parse(r.values_json || '{}');
                return <tr key={idx}>{fields.map((f: any) => <td key={f.key} className="py-0.5">{esc(values[f.key])}</td>)}</tr>;
              })}
            </tbody>
          </table>
          </div>
        </div>
      );
    }
    case 'report':
      return (
        <div className={box}>
          {row('مخاطبین', result.data.totalContacts)}
          {row('معاملات باز', result.data.openDeals)}
          {row('ارزش پایپ‌لاین', result.data.pipelineValue)}
          {row('فروش برنده‌شده', result.data.wonValue)}
        </div>
      );
    default:
      return null; // report_data handled separately above
  }
}

export default function ChatPanel() {
  const [agentName, setAgentName] = useState('Agent');
  const [userId, setUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOut, setVoiceOut] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognizerRef = useRef<any>(null);

  // Restore any saved conversation on mount so switching tabs (which
  // unmounts this component in the App Router) doesn't wipe the chat. Keyed
  // per-user (see chatStorageKey) so we must know who's logged in before
  // touching localStorage at all.
  useEffect(() => {
    api('me').then((me) => {
      const name = me.user.agent_name || 'Agent';
      setAgentName(name);
      setUserId(me.user.id);

      let restored: Msg[] | null = null;
      try {
        const raw = window.localStorage.getItem(chatStorageKey(me.user.id));
        if (raw) restored = JSON.parse(raw);
      } catch {
        /* ignore corrupt storage */
      }

      if (restored && restored.length) {
        setMessages(restored);
      } else {
        setMessages([{ role: 'agent', text: `سلام 👋 من ${name} هستم، دستیار شما در AgentOS. می‌تونی با متن یا صدا باهام صحبت کنی.` }]);
      }
    });
  }, []);

  // Save on every change (skip until we know which user this is).
  useEffect(() => {
    if (!userId || messages.length === 0) return;
    try {
      window.localStorage.setItem(chatStorageKey(userId), JSON.stringify(messages.slice(-60)));
    } catch {
      /* storage full or unavailable — non-fatal */
    }
  }, [messages, userId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function speak(text: string) {
    if (!voiceOut || typeof window === 'undefined' || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fa-IR';
    window.speechSynthesis.speak(u);
  }

  function toggleVoiceInput() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert('مرورگر شما از ورودی صوتی پشتیبانی نمی‌کنه. Chrome رو امتحان کن.');
      return;
    }
    if (listening) {
      recognizerRef.current?.stop();
      return;
    }
    const recognizer = new SR();
    recognizer.lang = 'fa-IR';
    recognizer.interimResults = false;
    recognizer.onstart = () => setListening(true);
    recognizer.onend = () => setListening(false);
    recognizer.onerror = () => setListening(false);
    recognizer.onresult = (e: any) => {
      const text = e.results[0][0].transcript;
      setInput(text);
      handleSend(text);
    };
    recognizerRef.current = recognizer;
    recognizer.start();
  }

  async function handleSend(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    // Snapshot the plain-text history BEFORE appending the new turn, so we
    // send "what was said before this message" — not including it twice.
    const history = messages
      .filter((m) => !m.thinking)
      .slice(-8)
      .map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [...m, { role: 'user', text }, { role: 'agent', text: '⏳ در حال پردازش...', thinking: true }]);

    try {
      const result = await api('agent/act', { method: 'POST', body: JSON.stringify({ text, history }) });
      setMessages((m) => {
        const withoutThinking = m.filter((x) => !x.thinking);
        if (result.requiresApproval) {
          return [
            ...withoutThinking,
            { role: 'agent', text: result.reply, pendingId: result.pendingId, action: result.action, params: result.params, resolved: null }
          ];
        }
        speak(result.reply || '');
        return [...withoutThinking, { role: 'agent', text: result.reply || 'انجام شد.', result: result.result }];
      });
    } catch (e: any) {
      setMessages((m) => [...m.filter((x) => !x.thinking), { role: 'agent', text: 'خطا: ' + e.message }]);
    } finally {
      setSending(false);
    }
  }

  async function resolvePending(pendingId: string, approve: boolean) {
    try {
      await api(`agent/pending/${pendingId}/${approve ? 'approve' : 'reject'}`, { method: 'POST' });
      setMessages((m) => m.map((msg) => (msg.pendingId === pendingId ? { ...msg, resolved: approve ? 'approved' : 'rejected' } : msg)));
    } catch (e: any) {
      alert(e.message);
    }
  }

  function downloadReport(reportType: string, format: 'xlsx' | 'csv') {
    window.open(`/api/proxy/reports/${reportType}.${format}`, '_blank');
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 sm:px-6 py-3.5 border-b border-[var(--border-soft)] font-extrabold text-sm">{agentName} — دستیار CRM شما</div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-6 py-5 flex flex-col gap-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-2.5 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div
              className={`w-6.5 h-6.5 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                m.role === 'user' ? 'bg-[var(--surface-3)] border border-[var(--border)]' : 'bg-gradient-to-br from-[var(--primary)] to-[#9c7d1c] text-[#1a1400]'
              }`}
            >
              {m.role === 'user' ? 'شما' : 'A'}
            </div>
            <div className="max-w-[88%] sm:max-w-[74%]">
              <div
                className={`px-3.5 py-2.5 rounded-2xl text-sm leading-7 ${
                  m.role === 'user'
                    ? 'bg-[var(--primary-soft)] border border-[var(--primary-dim)] text-[#f2e2ae] rounded-tl-2xl rounded-tr-md'
                    : 'bg-[var(--surface-2)] border border-[var(--border-soft)] rounded-tr-2xl rounded-tl-md'
                }`}
              >
                {m.text}
              </div>

              {m.pendingId && (
                <div className="mt-1.5 border border-[var(--danger)]/30 border-r-[3px] border-r-[var(--danger)] bg-[var(--surface-2)] rounded-lg rounded-r-sm p-3 text-xs">
                  <div className="text-[var(--danger)] font-bold mb-1.5">نیاز به تایید — {m.action}</div>
                  <pre className="text-[10.5px] text-[var(--text-3)] whitespace-pre-wrap break-all" dir="ltr">
                    {JSON.stringify(m.params)}
                  </pre>
                  {m.resolved ? (
                    <div className={`text-xs mt-1.5 ${m.resolved === 'approved' ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                      {m.resolved === 'approved' ? '✅ تایید شد' : '✖️ رد شد'}
                    </div>
                  ) : (
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => resolvePending(m.pendingId!, true)}
                        className="flex-1 bg-[var(--success-soft)] text-[var(--success)] rounded-md py-1.5 text-xs font-bold"
                      >
                        تایید
                      </button>
                      <button
                        onClick={() => resolvePending(m.pendingId!, false)}
                        className="flex-1 bg-[var(--danger-soft)] text-[var(--danger)] rounded-md py-1.5 text-xs font-bold"
                      >
                        رد
                      </button>
                    </div>
                  )}
                </div>
              )}

              {m.result?.type === 'report_data' && (
                <div className="mt-1.5 border border-[var(--border)] border-r-[3px] border-r-[var(--primary)] bg-[var(--surface-2)] rounded-lg rounded-r-sm p-3 text-xs">
                  <b>گزارش {m.result.data.reportType}</b>
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => downloadReport(m.result.data.reportType, 'xlsx')} className="border border-[var(--border)] rounded-md px-3 py-1.5 text-xs">
                      ⬇ دانلود Excel
                    </button>
                  </div>
                </div>
              )}
              {m.result && m.result.type !== 'report_data' && <ResultCard result={m.result} />}
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-3.5 border-t border-[var(--border-soft)]">
        <div className="flex gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-2xl p-1.5">
          <button
            onClick={toggleVoiceInput}
            className={`w-9 h-9 rounded-lg border border-[var(--border)] flex items-center justify-center shrink-0 ${
              listening ? 'bg-[var(--danger-soft)] text-[var(--danger)] animate-pulse' : 'bg-[var(--surface-3)]'
            }`}
          >
            🎙️
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="مثلاً: مشتری جدید ثبت کن به نام آقای رضایی"
            className="flex-1 bg-transparent outline-none text-sm px-2"
          />
          <button onClick={() => handleSend()} className="w-9 h-9 rounded-lg bg-[var(--primary)] text-[#1a1400] shrink-0">
            ↑
          </button>
        </div>
        <label className="flex items-center justify-center gap-1.5 text-[10px] text-[var(--text-3)] mt-1.5">
          <input type="checkbox" checked={voiceOut} onChange={(e) => setVoiceOut(e.target.checked)} />
          پاسخ Agent با صدا خوانده بشه
        </label>
      </div>
    </div>
  );
}
