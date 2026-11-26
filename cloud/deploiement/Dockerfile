# iMiel Cloud (serveur de transfert) : image autonome (Node 22, aucun module natif).
# Construire depuis le dossier cloud/ : docker build -f deploiement/Dockerfile -t imiel-cloud .
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NUAGE_HOTE=0.0.0.0 NUAGE_PORT=8787 NUAGE_BASE=/donnees/cloud.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY commun ./commun
COPY serveur ./serveur
USER node
VOLUME ["/donnees"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "serveur/serveur.mjs"]
