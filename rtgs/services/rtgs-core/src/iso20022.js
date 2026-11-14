'use strict';
// ISO 20022 message builders (simulation). The canonical outbound format for payment events:
//   pacs.008.001.08  FIToFICustomerCreditTransfer  - the payment instruction (on receipt)
//   pacs.002.001.10  FIToFIPaymentStatusReport     - every later status change
// Each event carries the message both as a JSON-mapped object and as XML.
const crypto = require('node:crypto');
const { toDecimal } = require('./money');

const PACS008 = 'pacs.008.001.08';
const PACS002 = 'pacs.002.001.10';

// ISO 20022 ExternalPaymentTransactionStatus1Code
const TX_STATUS = { QUEUED: 'PDNG', SETTLED: 'ACSC', REJECTED: 'RJCT', CANCELLED: 'RJCT' };

const hex = (uuid) => uuid.replace(/-/g, '');                     // 32 chars: fits Max35Text
const newMsgId = () => crypto.randomUUID().replace(/-/g, '');
const agent = (id) => ({ FinInstnId: { ClrSysMmbId: { MmbId: id } } });

function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toXml(name, v) {
  if (v !== null && typeof v === 'object') {
    const attrs = Object.entries(v).filter(([k]) => k[0] === '@').map(([k, a]) => ` ${k.slice(1)}="${esc(a)}"`).join('');
    const inner = Object.entries(v).filter(([k]) => k[0] !== '@')
      .map(([k, c]) => (k === '#' ? esc(c) : toXml(k, c))).join('');
    return `<${name}${attrs}>${inner}</${name}>`;
  }
  return `<${name}>${esc(v)}</${name}>`;
}

function wrap(messageType, rootName, body) {
  const document = { Document: { '@xmlns': `urn:iso:std:iso:20022:tech:xsd:${messageType}`, [rootName]: body } };
  return { messageType, document, xml: `<?xml version="1.0" encoding="UTF-8"?>${toXml('Document', document.Document)}` };
}

/** pacs.008: the credit transfer instruction for one payment row. */
function pacs008(p) {
  return wrap(PACS008, 'FIToFICstmrCdtTrf', {
    GrpHdr: {
      MsgId: newMsgId(),
      CreDtTm: new Date(p.created_at).toISOString(),
      NbOfTxs: '1',
      SttlmInf: { SttlmMtd: 'CLRG' },
    },
    CdtTrfTxInf: {
      PmtId: {
        InstrId: hex(p.id),
        EndToEndId: p.end_to_end_id || 'NOTPROVIDED',
        TxId: hex(p.id),
        UETR: p.id,
      },
      PmtTpInf: { InstrPrty: p.priority >= 5 ? 'HIGH' : 'NORM' },
      IntrBkSttlmAmt: { '@Ccy': p.currency, '#': toDecimal(p.amount) },
      ChrgBr: 'SLEV',
      Dbtr: { Nm: p.debtor },
      DbtrAgt: agent(p.debtor),
      CdtrAgt: agent(p.creditor),
      Cdtr: { Nm: p.creditor },
    },
  });
}

/** pacs.002: status report for the payment in its current state. */
function pacs002(p, status) {
  const tx = {
    OrgnlInstrId: hex(p.id),
    OrgnlEndToEndId: p.end_to_end_id || 'NOTPROVIDED',
    OrgnlTxId: hex(p.id),
    TxSts: TX_STATUS[status],
  };
  if (p.reason) tx.StsRsnInf = { Rsn: { Prtry: p.reason } };
  if (status === 'SETTLED' && p.settled_at) tx.AccptncDtTm = new Date(p.settled_at).toISOString();
  return wrap(PACS002, 'FIToFIPmtStsRpt', {
    GrpHdr: { MsgId: newMsgId(), CreDtTm: new Date().toISOString() },
    OrgnlGrpInfAndSts: { OrgnlMsgId: hex(p.id), OrgnlMsgNmId: PACS008 },
    TxInfAndSts: tx,
  });
}

/** Outbox event for a payment entering `toStatus`. RECEIVED -> pacs.008, everything else -> pacs.002. */
function eventFor(payment, toStatus) {
  const msg = toStatus === 'RECEIVED' ? pacs008(payment) : pacs002(payment, toStatus);
  return {
    eventType: msg.messageType,
    payload: { paymentId: payment.id, paymentStatus: toStatus, message: msg },
  };
}

module.exports = { pacs008, pacs002, eventFor, toXml, PACS008, PACS002, TX_STATUS };
