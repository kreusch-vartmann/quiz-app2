# syntax=docker/dockerfile:1

# ─── Stage 1: Abhängigkeiten installieren ────────────────────────────────────
FROM node:18-alpine AS deps

WORKDIR /app

# Nur package.json kopieren für besseres Layer-Caching
COPY package*.json ./

# Produktions-Abhängigkeiten installieren
# sqlite3 benötigt native Kompilierung → python3 und build-tools nötig
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++

# ─── Stage 2: Produktions-Image ───────────────────────────────────────────────
FROM node:18-alpine AS production

WORKDIR /app

# Quellcode und node_modules aus deps-Stage übernehmen
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Persistentes Datenverzeichnis für SQLite anlegen
# node:node → damit der non-root User "node" schreiben darf
RUN mkdir -p /app/data && chown -R node:node /app/data

# Port freigeben (Coolify überschreibt via PORT-Env)
EXPOSE 3000

# Als nicht-privilegierter User starten (Security Best Practice)
USER node

# Health-Check für Container-Orchestrierung
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

# Anwendung starten
CMD ["node", "server.js"]
