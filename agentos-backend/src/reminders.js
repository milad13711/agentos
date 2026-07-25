// reminders.js — sends a Telegram message when a task's due_at arrives, for
// any assignee who has linked their Telegram (see telegram.js / Settings ->
// اتصال تلگرام). Channel choice was explicit: Telegram for phase 1, not
// push/SMS.
const { db, now } = require('./db');
const { sendMessage } = require('./telegram');

async function checkAndSendReminders() {
  const due = await db.all(
    `SELECT t.id, t.title, u.telegram_chat_id FROM tasks t
     JOIN users u ON u.id = t.assignee_id
     WHERE t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at <= ?
       AND t.reminder_sent_at IS NULL AND u.telegram_chat_id IS NOT NULL`,
    [now()]
  );
  for (const task of due) {
    await sendMessage(task.telegram_chat_id, `⏰ یادآوری: «${task.title}» الان موعدشه.`);
    await db.run('UPDATE tasks SET reminder_sent_at = ? WHERE id = ?', [now(), task.id]);
  }
  return due.length;
}

function startReminderWorker(intervalMs = 60_000) {
  return setInterval(() => {
    checkAndSendReminders().catch((e) => console.error('[reminders]', e));
  }, intervalMs);
}

module.exports = { checkAndSendReminders, startReminderWorker };
