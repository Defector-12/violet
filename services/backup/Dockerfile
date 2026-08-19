FROM node:22.23.2-bookworm-slim AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.21.0

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @violet/backup build \
  && pnpm --filter @violet/backup-service build \
  && pnpm --filter @violet/backup-service deploy --prod /opt/violet-backup

FROM node:22.23.2-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /opt/violet-backup

COPY --from=build --chown=node:node /opt/violet-backup ./

USER node
ENTRYPOINT ["node", "dist/main.js"]
CMD ["encrypt-upload"]
