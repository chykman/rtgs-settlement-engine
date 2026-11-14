'use strict';
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => parseInt(v, 10));   // BIGINT -> number (outbox ids, offsets)

function createPool(connectionString = process.env.DATABASE_URL) {
  return new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 5) });
}

module.exports = { createPool };
