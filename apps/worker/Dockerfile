# Maturador + Anti-golpista: worker (BullMQ, roda TS fonte via tsx). Contexto = raiz do monorepo.
# Também é a imagem do serviço `migrate` (node --import tsx src/migrate.ts, em packages/db).
# docker build -f apps/worker/Dockerfile -t mag/worker .
FROM node:22-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages/ packages/
COPY modules/ modules/
# worker importa modules/* direto (ex.: modules/accounts/src/...) → instala worker + módulos; tsx é devDependency
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod=false --filter "@mag/worker..." --filter "./packages/*" --filter "./modules/*"
COPY tsconfig.base.json ./
COPY apps/worker/ apps/worker/
RUN groupadd -r app && useradd -r -g app app && chown -R app:app /repo
USER app
WORKDIR /repo/apps/worker
CMD ["node", "--import", "tsx", "src/main.ts"]
