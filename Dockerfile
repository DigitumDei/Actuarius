FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git gh ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM deps AS prod-deps

RUN npm prune --omit=dev

FROM base AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/app.db

COPY --from=deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /app/entrypoint.sh

RUN useradd --create-home --shell /usr/sbin/nologin appuser \
  && mkdir -p /data \
  && chmod +x /app/entrypoint.sh \
  && chown -R appuser:appuser /app /data

USER appuser
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "process.exit(0)"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/index.js"]
