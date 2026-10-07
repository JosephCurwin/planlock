FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/protocol.yaml ./src/protocol.yaml
COPY profiles ./profiles
COPY examples ./examples
COPY scripts ./scripts
USER node
EXPOSE 3001 4001
CMD ["node", "dist/http.js"]
