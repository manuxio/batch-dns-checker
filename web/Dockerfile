# --- Build stage: compile the React app with Vite ---
FROM node:20-bookworm AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage: serve static files + proxy API via nginx (non-root) ---
# The unprivileged image runs as uid 101 and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
USER root
# Apply OS security patches available for the base image (e.g. openssl).
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
