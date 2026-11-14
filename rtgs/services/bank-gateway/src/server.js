'use strict';
const { createApp } = require('./app');

const need = (n) => { if (!process.env[n]) { console.error(`${n} is required`); process.exit(1); } return process.env[n]; };

// BANK_KEYS: "keyA=BANKA,keyB=BANKB,...";  OPERATOR_KEY: single operator credential
const keys = {};
for (const pair of need('BANK_KEYS').split(',')) {
  const [k, bank] = pair.split('=');
  if (!k || !bank) { console.error('BANK_KEYS must look like key1=BANKA,key2=BANKB'); process.exit(1); }
  keys[k.trim()] = { role: 'bank', bank: bank.trim() };
}
keys[need('OPERATOR_KEY')] = { role: 'operator' };

const app = createApp({
  coreUrl: need('CORE_URL'),
  internalToken: need('INTERNAL_TOKEN'),
  keys,
  demoMode: process.env.DEMO_MODE === 'true',
  gitSha: process.env.GIT_SHA || 'dev',
  log: (o) => console.log(JSON.stringify(o)),
});
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => console.log(JSON.stringify({ level: 'info', msg: 'bank-gateway listening', port })));
const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
