FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/cryptstats.db

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/market > /dev/null || exit 1

CMD ["node", "src/server.js"]
