FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/signal-server/package.json apps/signal-server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --workspace @kenet/signal-server --workspace @kenet/protocol
COPY tsconfig.base.json ./
COPY apps/signal-server apps/signal-server
COPY packages/protocol packages/protocol
RUN npm run build -w @kenet/protocol && npm run build -w @kenet/signal-server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/signal-server/package.json apps/signal-server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev --workspace @kenet/signal-server --workspace @kenet/protocol
COPY --from=build /app/apps/signal-server/dist apps/signal-server/dist
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
EXPOSE 8080
ENV PORT=8080
CMD ["node", "apps/signal-server/dist/index.js"]