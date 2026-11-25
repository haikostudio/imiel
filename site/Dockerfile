# Vitrine getimiel.com : site statique fabrique par build.mjs, servi par nginx.
FROM node:22-alpine AS build
WORKDIR /site
COPY . .
RUN node build.mjs

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site/dist /usr/share/nginx/html
