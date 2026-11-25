# onnxruntime-node tente de telecharger un build GPU (CUDA) introuvable (404) : on le saute, le worker tourne sur CPU.
ARG ONNXRUNTIME_NODE_INSTALL_CUDA=skip

# Debian (glibc), pas Alpine : onnxruntime-node (dep de fastembed) n'a pas de
# binaire prebuilt musl -> require() throw sur Alpine et crash le worker.
FROM node:20-slim AS builder

WORKDIR /app

# python3/make/g++ requis pour compiler better-sqlite3 (pas de prebuilt
# binaire trouve : prebuild-install detecte libc="" sur node:20-slim et
# tombe en node-gyp rebuild).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage dedie pour compiler les prod deps natives (better-sqlite3) sans
# trainer python/g++ dans l'image finale.
FROM node:20-slim AS prod-deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --omit=dev

FROM node:20-slim

WORKDIR /app

# libgomp1 : runtime OpenMP requis par onnxruntime-node (fastembed).
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY --from=prod-deps /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist

# Modele d'embeddings pre-telecharge (all-MiniLM-L6-v2, ~90 Mo). Le path est
# absolu et writable par le user "node" -> fastembed n'a plus besoin de
# mkdir('local_cache') dans le cwd au demarrage (EACCES en user non-root).
# Le --chown garantit que node peut ecrire dedans si fastembed veut un jour
# pousser un model.tar.gz temporaire.
COPY --chown=node:node local_cache/ /app/local_cache/
ENV FASTEMBED_CACHE_DIR=/app/local_cache

EXPOSE 4001

USER node

CMD ["node", "dist/index.js"]
