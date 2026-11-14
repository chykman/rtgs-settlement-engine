FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "src/server.js"]
