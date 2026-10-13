# syntax=docker/dockerfile:1
# ---- build: web bundle + server JS ----
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build

# ---- prod deps only ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server --no-audit --no-fund

# ---- kubectl (used for `kubectl kustomize` on GitHub deploys) ----
FROM debian:bookworm-slim AS kubectl
ARG KUBECTL_VERSION=v1.36.3
ADD https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl /kubectl
RUN chmod 755 /kubectl

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    DATA_DIR=/data \
    WEB_DIR=/app/web/dist
WORKDIR /app
COPY --from=kubectl /kubectl /usr/local/bin/kubectl
COPY --from=deps /app/node_modules node_modules
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/server/package.json server/package.json
COPY --from=build /src/web/dist web/dist
COPY package.json ./
USER 1000:1000
EXPOSE 8081
WORKDIR /app/server
CMD ["node", "dist/index.js"]
