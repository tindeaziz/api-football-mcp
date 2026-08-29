FROM node:22-alpine

WORKDIR /app

# Active pnpm fourni avec Node.js/Corepack
RUN corepack enable

# Copier uniquement les fichiers réellement présents dans le dépôt
COPY package.json ./

# Installer les dépendances
RUN pnpm install

# Copier le reste du code source
COPY . .

# Compiler le projet
RUN pnpm run build

# Démarrer le serveur MCP
CMD ["node", "dist/server.js"]
