'use strict';
// Decimal string <-> integer minor units. Never use floats for money.
class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR') { super(message); this.code = code; this.status = 400; }
}

function toMinor(value) {
  if (typeof value !== 'string') throw new ValidationError('amount must be a decimal string, e.g. "1250.50"');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new ValidationError('amount must be a positive decimal with at most 2 fraction digits');
  const minor = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new ValidationError('amount must be greater than zero');
  return minor;
}

function toDecimal(minor) {
  const n = Number(minor);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

module.exports = { toMinor, toDecimal, ValidationError };
