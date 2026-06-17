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

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3001

CMD ["node", "dist/index.js"]
