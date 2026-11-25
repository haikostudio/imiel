# Stage 1: Install dependencies
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Stage 2: Build the application
FROM node:20-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

ARG POCKETBASE_INTERNAL_URL=http://127.0.0.1:8090
ARG WORKER_INTERNAL_URL=http://127.0.0.1:4001
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY=""
ARG NEXT_PUBLIC_POCKETBASE_URL=""
ENV POCKETBASE_INTERNAL_URL=$POCKETBASE_INTERNAL_URL
ENV WORKER_INTERNAL_URL=$WORKER_INTERNAL_URL
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV NEXT_PUBLIC_POCKETBASE_URL=$NEXT_PUBLIC_POCKETBASE_URL

# Version servie par /build-version (lue par next.config.ts). Le contexte de
# build n'a pas de .git : sans ces valeurs, la version retombe sur "dev-..."
# et le deploiement ne peut pas prouver quel commit tourne. Passees par
# deploy/deployer-serveur-clients.sh (--build-arg).
ARG BUILD_HASH=""
ARG BUILD_TIME=""
ENV BUILD_HASH=$BUILD_HASH
ENV BUILD_TIME=$BUILD_TIME

RUN npm run build

# Stage 3: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

RUN mkdir .next
RUN chown nextjs:nodejs .next

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Rename standalone server and add custom wrapper for WebSocket proxy
RUN mv server.js server.next.js
COPY --from=builder --chown=nextjs:nodejs /app/server.custom.js ./server.js

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
