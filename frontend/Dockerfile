# ── Build stage ────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

ARG VITE_API_URL=http://localhost:8000

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ── Serve stage ────────────────────────────────────────
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

# SPA fallback + gzip compression + static asset caching
RUN printf 'server {\n\
    listen 80;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    \n\
    gzip on;\n\
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;\n\
    gzip_min_length 256;\n\
    \n\
    # Cache hashed assets for 1 year\n\
    location /assets/ {\n\
    expires 1y;\n\
    add_header Cache-Control "public, immutable";\n\
    }\n\
    \n\
    # Short cache for index.html and other root files\n\
    location = /index.html {\n\
    add_header Cache-Control "no-cache";\n\
    }\n\
    \n\
    location / {\n\
    try_files $uri $uri/ /index.html;\n\
    }\n\
    }\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
