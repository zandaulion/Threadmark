FROM docker.io/library/node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ENV NODE_ENV=production
WORKDIR /srv/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY app/server ./server
COPY app/web ./web
VOLUME ["/data"]
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=4391 INTERNAL_PORT=4390
EXPOSE 4391
CMD ["node", "server/index.mjs"]
