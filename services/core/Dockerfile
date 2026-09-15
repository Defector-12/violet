FROM node:22.23.2-bookworm-slim AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.21.0

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm generate \
  && pnpm -r build \
  && pnpm --filter @violet/core deploy --prod /opt/violet-core

FROM node:22.23.2-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /opt/violet-core

COPY --from=build --chown=node:node /opt/violet-core ./
COPY --from=build --chown=node:node /workspace/infra/migrations ./migrations

RUN mkdir -p /var/lib/violet/test-traces && chown node:node /var/lib/violet/test-traces && chmod 700 /var/lib/violet/test-traces

USER node
EXPOSE 4310
CMD ["node", "dist/bootstrap.js"]
