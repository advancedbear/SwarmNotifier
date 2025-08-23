FROM node:20-alpine3.20
ENV NODE_ENV production

RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node app .
RUN npm install --production

USER node
CMD ["node", "index.js"]