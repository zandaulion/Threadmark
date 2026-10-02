FROM docker.io/library/node:24-alpine
ENV NODE_ENV=production
WORKDIR /srv/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY app/server ./server
COPY app/web ./web
VOLUME ["/data"]
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=4391
EXPOSE 4391
CMD ["node", "server/index.mjs"]
