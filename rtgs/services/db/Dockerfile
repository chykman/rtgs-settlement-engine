# Context is ./services so the schema has ONE source of truth: rtgs-core/migrations.
# (rtgs-core still runs the same idempotent migrations on boot, so upgrades of an existing volume work too.)
#
# Extensions: none are compiled here on purpose. gen_random_uuid() is built into PostgreSQL 13+ and
# pgcrypto already ships with the official image. If you add PostGIS or a custom extension, add a
# build stage that compiles it and COPY --from=build its .so and .control/.sql files into
# /usr/local/lib/postgresql and /usr/local/share/postgresql/extension.
FROM postgres:16-alpine AS production

# Runs once, on first start of an empty data directory, as the postgres user: accounts, payments,
# ledger_entries, audit_log, system_state, outbox and message_store (001_*.sql, 002_*.sql in order).
COPY --chown=postgres:postgres rtgs-core/migrations/*.sql /docker-entrypoint-initdb.d/

# Defaults only. POSTGRES_PASSWORD must be supplied at run time (secret), never baked in.
ENV POSTGRES_DB=rtgs \
    POSTGRES_USER=rtgs

EXPOSE 5432

# idle_in_transaction_session_timeout: the outbox relay holds a transaction while it talks to Kafka,
# so a stuck worker must not hold locks forever.
CMD ["postgres", \
     "-c", "password_encryption=scram-sha-256", \
     "-c", "idle_in_transaction_session_timeout=60000", \
     "-c", "log_connections=on", \
     "-c", "log_min_duration_statement=500"]

# The official entrypoint drops to the non-root `postgres` user.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" || exit 1
