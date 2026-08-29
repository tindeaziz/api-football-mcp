FROM node:22-alpine

WORKDIR /app

# Installer pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copier les manifests
COPY package.json pnpm-lock.yaml ./

# Installer les dépendances
RUN pnpm install --frozen-lockfile --prod

# Copier le code
COPY . .

# Builder
RUN pnpm run build

# Point d'entrée
ENTRYPOINT ["node", "dist/server.js"]
