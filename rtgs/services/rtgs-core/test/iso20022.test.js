'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const iso = require('../src/iso20022');

const payment = {
  id: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', end_to_end_id: 'E2E-1', debtor: 'BANKA', creditor: 'BANKB',
  amount: 12550, currency: 'XTS', priority: 7, reason: null,
  created_at: new Date('2026-01-02T03:04:05Z'), settled_at: null,
};

test('pacs.008 carries the instruction fields', () => {
  const m = iso.pacs008(payment);
  assert.equal(m.messageType, 'pacs.008.001.08');
  const tx = m.document.Document.FIToFICstmrCdtTrf.CdtTrfTxInf;
  assert.equal(tx.IntrBkSttlmAmt['#'], '125.50');
  assert.equal(tx.IntrBkSttlmAmt['@Ccy'], 'XTS');
  assert.equal(tx.PmtId.UETR, payment.id);
  assert.equal(tx.PmtId.EndToEndId, 'E2E-1');
  assert.equal(tx.PmtId.TxId.length, 32);
  assert.equal(tx.PmtTpInf.InstrPrty, 'HIGH');
  assert.match(m.xml, /^<\?xml version="1.0" encoding="UTF-8"\?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs\.008\.001\.08">/);
  assert.match(m.xml, /<IntrBkSttlmAmt Ccy="XTS">125\.50<\/IntrBkSttlmAmt>/);
});

test('pacs.002 maps payment status to ISO status codes', () => {
  const code = (s, p = payment) => iso.pacs002(p, s).document.Document.FIToFIPmtStsRpt.TxInfAndSts.TxSts;
  assert.equal(code('SETTLED'), 'ACSC');
  assert.equal(code('QUEUED'), 'PDNG');
  assert.equal(code('REJECTED'), 'RJCT');
  assert.equal(code('CANCELLED'), 'RJCT');
  const q = iso.pacs002({ ...payment, reason: 'INSUFFICIENT_LIQUIDITY' }, 'QUEUED').document.Document.FIToFIPmtStsRpt.TxInfAndSts;
  assert.equal(q.StsRsnInf.Rsn.Prtry, 'INSUFFICIENT_LIQUIDITY');
  assert.equal(iso.pacs002(payment, 'SETTLED').document.Document.FIToFIPmtStsRpt.OrgnlGrpInfAndSts.OrgnlMsgNmId, 'pacs.008.001.08');
});

test('eventFor: RECEIVED is a pacs.008, every later state a pacs.002', () => {
  assert.equal(iso.eventFor(payment, 'RECEIVED').eventType, 'pacs.008.001.08');
  for (const s of ['QUEUED', 'SETTLED', 'REJECTED', 'CANCELLED']) assert.equal(iso.eventFor(payment, s).eventType, 'pacs.002.001.10');
  assert.equal(iso.eventFor(payment, 'SETTLED').payload.paymentId, payment.id);
});

test('XML output escapes untrusted text', () => {
  const m = iso.pacs008({ ...payment, end_to_end_id: 'a<b>&"c' });
  assert.ok(m.xml.includes('a&lt;b&gt;&amp;&quot;c'));
  assert.ok(!m.xml.includes('a<b>'));
});
