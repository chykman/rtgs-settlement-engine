ARG JAVA_IMAGE=eclipse-temurin:17-jre-alpine

# ---- Stage 1: download, verify and trim the Kafka distribution -----------------------------------
# hadolint ignore=DL3006
# hadolint ignore=DL3006
FROM ${JAVA_IMAGE} AS fetch
ARG KAFKA_VERSION=3.6.2
ARG SCALA_VERSION=2.13
WORKDIR /tmp
# Pipes only feed the checksum comparison, whose own exit status decides the build.
# hadolint ignore=DL4006
RUN set -eux; \
    base="kafka_${SCALA_VERSION}-${KAFKA_VERSION}"; \
    url="https://archive.apache.org/dist/kafka/${KAFKA_VERSION}"; \
    wget -q "${url}/${base}.tgz"; \
    wget -q "${url}/${base}.tgz.sha512"; \
    expected="$(sed 's/^[^:]*://' "${base}.tgz.sha512" | tr -d ' \n' | tr '[:upper:]' '[:lower:]')"; \
    echo "${expected}  ${base}.tgz" | sha512sum -c -; \
    tar -xzf "${base}.tgz" -C /opt; \
    mv "/opt/${base}" /opt/kafka; \
    rm -rf /opt/kafka/bin/windows /opt/kafka/site-docs

# ---- Stage 2: minimal runtime ---------------------------------------------------------------------
# hadolint ignore=DL3006
# hadolint ignore=DL3006
FROM ${JAVA_IMAGE} AS production
# Kafka's shell scripts need bash; nothing else is added to the runtime image.
# hadolint ignore=DL3018
RUN apk add --no-cache bash \
 && addgroup -g 1001 -S kafka \
 && adduser -u 1001 -S -G kafka -H -h /opt/kafka -s /sbin/nologin kafka \
 && mkdir -p /var/lib/kafka/data \
 && chown -R 1001:1001 /var/lib/kafka

COPY --from=fetch --chown=1001:1001 /opt/kafka /opt/kafka
COPY --chown=1001:1001 config/ /opt/kafka/config/rtgs/
COPY --chmod=0555 entrypoint.sh /usr/local/bin/kafka-entrypoint

ARG KAFKA_VERSION=3.6.2
LABEL org.opencontainers.image.title="kafka-kraft" \
      org.opencontainers.image.version="${KAFKA_VERSION}"

USER 1001:1001
WORKDIR /opt/kafka
VOLUME ["/var/lib/kafka"]
EXPOSE 9092

# Run with: read_only: true, tmpfs /tmp (exec), cap_drop ALL, security_opt no-new-privileges.
# The config and the generated credentials live in /tmp (tmpfs); data lives in /var/lib/kafka.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["/opt/kafka/bin/kafka-broker-api-versions.sh", "--bootstrap-server", "localhost:9092", "--command-config", "/tmp/kafka/client.properties"]

ENTRYPOINT ["/usr/local/bin/kafka-entrypoint"]
