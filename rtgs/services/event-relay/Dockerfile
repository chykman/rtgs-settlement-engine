# One image, two roles: relay (default) and consumer (override the command).
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
USER node
# Healthy = the worker loop touched /tmp/healthy within the last 60s.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD test "$(( $(date +%s) - $(stat -c %Y /tmp/healthy) ))" -lt 60 || exit 1
CMD ["node", "src/run-relay.js"]
