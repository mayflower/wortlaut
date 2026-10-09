FROM node:22-bookworm-slim AS build
WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY worker/ ./
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app/worker
COPY --from=build /app/worker/node_modules ./node_modules
COPY --from=build /app/worker/dist-worker ./dist-worker
COPY --from=build /app/worker/dist/meet ./dist/meet
COPY worker/package.json ./
COPY worker/test/lifecycle-worker.mjs ./test/lifecycle-worker.mjs
USER pwuser
ENV NODE_ENV=production
CMD ["node", "dist-worker/runtime/main.js"]
