FROM node:22-alpine
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .
ENV NODE_ENV=production
RUN npm run build
CMD ["npm","run","start:api"]
