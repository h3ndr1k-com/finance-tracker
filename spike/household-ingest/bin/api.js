#!/usr/bin/env node
'use strict';
const path = require('path');
const { openStore } = require('../lib/queue');
const { createReviewServer } = require('../lib/api');

const token = process.env.SPIKE_TOKEN || 'spike-dev-token';
const port = Number(process.env.SPIKE_PORT || 8787);
const store = openStore(path.join(__dirname, '../.tmp'));
const server = createReviewServer({ store, token, port });
server.listen().then(({ host, port: p }) => {
  console.log(`review API on http://${host}:${p}/review  (Authorization: Bearer ${token})`);
});
