#!/usr/bin/env node
'use strict';
const path = require('path');
const { openStore } = require('../lib/queue');
const { runJob, runSchedule } = require('../lib/job');

const args = process.argv.slice(2);
const once = args.includes('--once');
const scheduleIdx = args.indexOf('--schedule');
const fixtureIdx = args.indexOf('--fixture');
const fixture = fixtureIdx >= 0
  ? args[fixtureIdx + 1]
  : path.join(__dirname, '../fixtures/day-1.json');
const dir = path.join(__dirname, '../.tmp');
const store = openStore(dir);

if (scheduleIdx >= 0 && !once) {
  const intervalMs = Number(args[scheduleIdx + 1] || 5000);
  console.log(`scheduling mock ingest every ${intervalMs}ms from ${fixture}`);
  runSchedule({
    store,
    fixture,
    intervalMs,
    onTick: (summary, n) => console.log(JSON.stringify({ tick: n, ...summary })),
  });
} else {
  const summary = runJob({ store, fixture });
  console.log(JSON.stringify(summary, null, 2));
}
