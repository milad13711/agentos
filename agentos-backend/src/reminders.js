// reminders.js — fires when a task's due_at arrives (hour/minute precision —
// see actions.js's computeDueAt), over BOTH channels independently: Telegram
// (for any assignee who's linked theirs — see telegram.js / Settings ->
// اتصال تلگرام) and Web Push (for any assignee with a subscribed
// browser/PWA install — see push.js). Neither channel being configured is
// fine; a task with no reachable channel still gets reminder_sent_at set so
// it isn't retried forever once its due moment has passed.
const { db, now } = require('./db');
const { sendMessage } = require('./telegram');
const push = require('./push');

async function checkAndSendReminders() {
  const due = await db.all(
    `SELECT t.id, t.title, t.assignee_id, u.telegram_chat_id FROM tasks t
     JOIN users u ON u.id = t.assignee_id
     WHERE t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at <= ?
       AND t.reminder_sent_at IS NULL`,
    [now()]
  );
  let delivered = 0;
  for (const task of due) {
    const text = `⏰ یادآوری: «${task.title}» الان موعدشه.`;
    let reached = false;
    if (task.telegram_chat_id) {
      try {
        await sendMessage(task.telegram_chat_id, text);
        reached = true;
      } catch (e) {
        console.error('[reminders] telegram send failed:', e.message);
      }
    }
    try {
      const delivered = await push.sendPushToUser(task.assignee_id, { title: 'یادآوری AgentOS', body: text, url: '/tasks' });
      if (delivered > 0) reached = true;
    } catch (e) {
      console.error('[reminders] push send failed:', e.message);
    }
    // Marked as handled either way — an assignee with no linked channel at
    // all would otherwise be requeried forever, once every 60s, for good.
    await db.run('UPDATE tasks SET reminder_sent_at = ? WHERE id = ?', [now(), task.id]);
    if (reached) delivered++;
  }
  return delivered;
}

function startReminderWorker(intervalMs = 60_000) {
  return setInterval(() => {
    checkAndSendReminders().catch((e) => console.error('[reminders]', e));
  }, intervalMs);
}

module.exports = { checkAndSendReminders, startReminderWorker };
