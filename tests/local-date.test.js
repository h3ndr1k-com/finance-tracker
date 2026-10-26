'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { localISODate, reminderAddDays } = require('../reminders');

test('localISODate uses the calendar date of the Date object', () => {
  assert.equal(localISODate(new Date(2026, 9, 26, 21, 30, 0)), '2026-10-26');
  assert.equal(reminderAddDays('2026-10-26', 1), '2026-10-27');
});

test('Toronto evening stays on that local calendar day', () => {
  const script = `
    const { localISODate } = require(${JSON.stringify(path.join(__dirname, '..', 'reminders.js'))});
    const utc = new Date(Date.UTC(2026, 9, 27, 1, 30, 0));
    if (localISODate(utc) !== '2026-10-26') {
      console.error(localISODate(utc));
      process.exit(1);
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'America/Toronto' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
