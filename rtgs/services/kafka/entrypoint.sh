#!/usr/bin/env bash
# Builds the runtime config from environment variables (so no secret is baked into the image),
# formats KRaft storage on first start, then execs the broker so it receives SIGTERM directly.
set -euo pipefail
umask 077

: "${KAFKA_CLUSTER_ID:?set KAFKA_CLUSTER_ID (generate: kafka-storage.sh random-uuid)}"
: "${KAFKA_ADMIN_PASSWORD:?set KAFKA_ADMIN_PASSWORD}"
: "${KAFKA_APP_PASSWORD:?set KAFKA_APP_PASSWORD}"
PROTOCOL="${KAFKA_SECURITY_PROTOCOL:-SASL_PLAINTEXT}"      # SASL_PLAINTEXT (private network) | SASL_SSL
ADVERTISED_HOST="${KAFKA_ADVERTISED_HOST:-kafka}"
APP_USER="${KAFKA_APP_USER:-rtgs}"
CONF_DIR=/tmp/kafka
BASE=/opt/kafka/config/rtgs

# Passwords go inside a JAAS string, so keep them to a safe alphabet (no quotes, backslashes, spaces).
for v in KAFKA_ADMIN_PASSWORD KAFKA_APP_PASSWORD; do
  [[ "${!v}" =~ ^[A-Za-z0-9._~+/=-]{12,}$ ]] || { echo "$v must be 12+ chars of [A-Za-z0-9._~+/=-]" >&2; exit 1; }
done
[[ "$APP_USER" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "KAFKA_APP_USER has invalid characters" >&2; exit 1; }
case "$PROTOCOL" in SASL_PLAINTEXT|SASL_SSL) ;; *) echo "KAFKA_SECURITY_PROTOCOL must be SASL_PLAINTEXT or SASL_SSL" >&2; exit 1 ;; esac

mkdir -p "$CONF_DIR"
SERVER="$CONF_DIR/server.properties"
CLIENT="$CONF_DIR/client.properties"

cp "$BASE/server.properties" "$SERVER"
{
  echo "advertised.listeners=BROKER://${ADVERTISED_HOST}:9092"
  echo "listener.security.protocol.map=BROKER:${PROTOCOL},CONTROLLER:PLAINTEXT"
  echo "listener.name.broker.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username=\"admin\" password=\"${KAFKA_ADMIN_PASSWORD}\" user_admin=\"${KAFKA_ADMIN_PASSWORD}\" user_${APP_USER}=\"${KAFKA_APP_PASSWORD}\";"
} >> "$SERVER"

# Client config used by the HEALTHCHECK (and handy for kafka-topics.sh / kafka-console-consumer.sh).
{
  echo "security.protocol=${PROTOCOL}"
  echo "sasl.mechanism=PLAIN"
  echo "sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username=\"admin\" password=\"${KAFKA_ADMIN_PASSWORD}\";"
} > "$CLIENT"

if [[ "$PROTOCOL" == "SASL_SSL" ]]; then
  : "${KAFKA_SSL_KEYSTORE:?mount a keystore and set KAFKA_SSL_KEYSTORE}"
  : "${KAFKA_SSL_KEYSTORE_PASSWORD:?set KAFKA_SSL_KEYSTORE_PASSWORD}"
  : "${KAFKA_SSL_TRUSTSTORE:?mount a truststore and set KAFKA_SSL_TRUSTSTORE}"
  : "${KAFKA_SSL_TRUSTSTORE_PASSWORD:?set KAFKA_SSL_TRUSTSTORE_PASSWORD}"
  {
    echo "ssl.keystore.location=${KAFKA_SSL_KEYSTORE}"
    echo "ssl.keystore.password=${KAFKA_SSL_KEYSTORE_PASSWORD}"
    echo "ssl.key.password=${KAFKA_SSL_KEY_PASSWORD:-$KAFKA_SSL_KEYSTORE_PASSWORD}"
    echo "ssl.truststore.location=${KAFKA_SSL_TRUSTSTORE}"
    echo "ssl.truststore.password=${KAFKA_SSL_TRUSTSTORE_PASSWORD}"
    echo "ssl.client.auth=none"
  } >> "$SERVER"
  {
    echo "ssl.truststore.location=${KAFKA_SSL_TRUSTSTORE}"
    echo "ssl.truststore.password=${KAFKA_SSL_TRUSTSTORE_PASSWORD}"
    echo "ssl.endpoint.identification.algorithm="     # the local health probe connects to "localhost"
  } >> "$CLIENT"
fi

# First start formats the data dir with the cluster id; later starts are no-ops.
/opt/kafka/bin/kafka-storage.sh format --ignore-formatted -t "$KAFKA_CLUSTER_ID" -c "$SERVER"

export LOG_DIR="${LOG_DIR:-/tmp/kafka-logs}"
export KAFKA_HEAP_OPTS="${KAFKA_HEAP_OPTS:--Xms512m -Xmx512m}"
export KAFKA_LOG4J_OPTS="-Dlog4j.configuration=file:${BASE}/log4j.properties"
exec /opt/kafka/bin/kafka-server-start.sh "$SERVER"
