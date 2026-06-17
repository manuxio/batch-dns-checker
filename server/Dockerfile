# --- Build stage: compile TypeScript and native deps (better-sqlite3) ---
FROM node:20-bookworm AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies; keeps compiled native modules (better-sqlite3).
RUN npm prune --omit=dev

# --- Runtime stage: slim image with only production artifacts ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Apply OS security patches, and remove npm/npx from the runtime image: the
# app only runs `node dist/index.js`, and npm bundles its own (CVE-prone)
# dependencies (tar, cross-spawn, glob, minimatch) that would otherwise ship.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

ENV DATA_DIR=/data
# Run as the non-root "node" user. /data is created node-owned so a freshly
# created named volume inherits that ownership.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
