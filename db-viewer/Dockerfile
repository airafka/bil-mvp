FROM node:22-alpine AS check
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run lint && npm run build && npm test

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=check /app/server.mjs /app/database.mjs /app/attribute-notes.mjs /app/install-observer.mjs ./
COPY --from=check /app/public ./public
USER node
EXPOSE 3022
CMD ["node", "server.mjs"]
