'use strict';
/* Shared recurring-expense reminder logic for index.html and sw.js */

function localISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function reminderTodayISO() {
  return localISODate(new Date());
}

function reminderAddDays(iso, days) {
  const parts = String(iso || reminderTodayISO()).split('-').map(Number);
  const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  d.setDate(d.getDate() + days);
  return localISODate(d);
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    localISODate, reminderTodayISO, reminderAddDays, reminderTomorrowISO,
    reminderKey, subscriptionsDueOn, pendingRecurringReminders, reminderAmountLabel,
    reminderBody, pruneReminderLog,
  };
}
