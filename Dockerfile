FROM node:26.13.0-bookworm-slim AS workspace

RUN npm install --global pnpm@12.18.0 \
    && mkdir /app \
    && chown node:node /app
WORKDIR /app
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/redirect-service/package.json apps/redirect-service/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .

FROM workspace AS redirect
RUN pnpm --filter @url-shortener/redirect-service... build
ARG APP_REVISION=development
LABEL org.opencontainers.image.revision=${APP_REVISION}
ENV NODE_ENV=production LISTEN_HOST=0.0.0.0 APP_REVISION=${APP_REVISION}
EXPOSE 3000 9090
ENTRYPOINT ["sh", "/app/scripts/container-db.sh"]
CMD ["node", "apps/redirect-service/dist/server.js"]

FROM workspace AS web
ARG APP_REVISION=development
LABEL org.opencontainers.image.revision=${APP_REVISION}
ENV APP_REVISION=${APP_REVISION}
ARG REDIRECT_SERVICE_ORIGIN=http://redirect-service:3000
ARG NEXT_PUBLIC_SHORT_LINK_ORIGIN=http://127.0.0.1:3100
ENV NEXT_TELEMETRY_DISABLED=1 \
    REDIRECT_SERVICE_ORIGIN=${REDIRECT_SERVICE_ORIGIN} \
    NEXT_PUBLIC_SHORT_LINK_ORIGIN=${NEXT_PUBLIC_SHORT_LINK_ORIGIN}
RUN pnpm --filter @url-shortener/web build
ENV NODE_ENV=production
WORKDIR /app/apps/web
EXPOSE 3001
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3001"]
