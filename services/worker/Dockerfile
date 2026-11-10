FROM node:26-trixie-slim AS build
WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY worker/ ./
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund && rm -rf node_modules/@typescript

FROM mcr.microsoft.com/playwright:v1.65.0-noble
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends xdotool \
    && rm -rf /var/lib/apt/lists/* /usr/lib/node_modules/npm /usr/lib/node_modules/corepack /usr/lib/node_modules/yarn /usr/bin/npm /usr/bin/npx /usr/bin/corepack /usr/bin/yarn /usr/bin/yarnpkg
WORKDIR /app/worker
COPY --from=build /app/worker/node_modules ./node_modules
COPY --from=build /app/worker/dist-worker ./dist-worker
COPY --from=build /app/worker/dist/meet ./dist/meet
COPY worker/package.json ./
COPY worker/test/lifecycle-worker.mjs ./test/lifecycle-worker.mjs
USER pwuser
ENV NODE_ENV=production
CMD ["node", "dist-worker/runtime/main.js"]
