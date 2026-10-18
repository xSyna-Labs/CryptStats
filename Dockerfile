# CryptStats im Container. Es gibt keine Laufzeit-Abhängigkeiten:
# Node bringt HTTP und SQLite mit, das Frontend braucht keinen Build-Schritt.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/cryptstats.db \
    COOKIE_SECURE=false

WORKDIR /app

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node migrations ./migrations

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
