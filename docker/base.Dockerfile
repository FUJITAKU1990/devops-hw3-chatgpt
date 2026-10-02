FROM node:20-alpine

# Apply available Alpine security fixes and update npm to a Node 20-compatible
# release whose bundled dependencies include the patched tar version.
RUN apk update \
    && apk upgrade \
    && npm install -g npm@11.21.0 \
    && rm -rf /var/cache/apk/*

WORKDIR /app/database
COPY database/package.json database/package-lock.json ./
RUN npm ci --no-audit --maxsockets=1
COPY database/ ./
RUN npm run build

WORKDIR /app/packages/mail
COPY packages/mail/package.json packages/mail/package-lock.json ./
RUN npm ci --no-audit --maxsockets=1
COPY packages/mail/ ./
RUN npm run build

WORKDIR /app
