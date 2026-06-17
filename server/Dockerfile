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
VOLUME ["/data"]
EXPOSE 3001

CMD ["node", "dist/index.js"]
