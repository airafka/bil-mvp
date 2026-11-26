FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN --mount=type=cache,id=billing-mvp-eslint,target=/var/cache/eslint,sharing=locked \
    lint_key="$(sha256sum package.json package-lock.json eslint.config.js | sha256sum | cut -d ' ' -f1)" && \
    npm run lint -- --cache --cache-strategy content --cache-location "/var/cache/eslint/$lint_key" && \
    npm run test && npm run build

FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
