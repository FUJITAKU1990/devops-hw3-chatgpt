# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --maxsockets=1

COPY frontend/ .

ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM caddy:2-alpine

COPY --from=builder /app/frontend/dist /srv
COPY frontend/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443
