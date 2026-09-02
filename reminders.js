'use strict';
/* Shared recurring-expense reminder logic for index.html and sw.js */

function reminderTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function reminderAddDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function reminderTomorrowISO(fromISO) {
  return reminderAddDays(fromISO || reminderTodayISO(), 1);
}

function reminderKey(sub) {
  return `${sub.id}:${sub.date}`;
}

function subscriptionsDueOn(subs, iso) {
  return (subs || []).filter(s => s && s.date === iso && s.name);
}

function pendingRecurringReminders(subs, dueISO, sentLog) {
  const log = sentLog || {};
  return subscriptionsDueOn(subs, dueISO).filter(s => !log[reminderKey(s)]);
}

function reminderAmountLabel(sub) {
  if (sub.amount == null || Number.isNaN(+sub.amount)) return '';
  const amt = (+sub.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amt} ${sub.currency || ''}`.trim();
}

function reminderBody(sub, dueISO) {
  const parts = [reminderAmountLabel(sub)];
  if (sub.account) parts.push(sub.account);
  parts.push(`due ${dueISO}`);
  return parts.filter(Boolean).join(' · ');
}

function pruneReminderLog(log, todayISO) {
  const today = todayISO || reminderTodayISO();
  const out = {};
  for (const [key, sentOn] of Object.entries(log || {})) {
    const dueDate = key.slice(key.indexOf(':') + 1);
    if (dueDate >= today) out[key] = sentOn;
  }
  return out;
}
