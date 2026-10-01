FROM node:20-alpine

# Apply available Alpine security fixes and update npm to a Node 20-compatible
# release whose bundled dependencies include the patched tar version.
RUN apk update \
    && apk upgrade \
    && npm install -g npm@11.21.0 \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# 1. Build context is now root, so we just setup the specific service
WORKDIR /app/services/api-gateway
COPY services/api-gateway/package.json services/api-gateway/package-lock.json ./
RUN npm ci --no-audit --maxsockets=1

COPY services/api-gateway/ .

RUN chown -R node:node /app
USER node

CMD ["npm", "start"]
