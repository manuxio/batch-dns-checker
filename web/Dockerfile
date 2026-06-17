# --- Build stage: compile the React app with Vite ---
FROM node:20-bookworm AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage: serve static files + proxy API via nginx ---
FROM nginx:1.27-alpine AS runtime
# Apply OS security patches available for the base image (e.g. openssl).
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
