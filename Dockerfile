# Build the static site, then ship it with the API in one small image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8789
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src ./src
COPY server ./server
COPY cli ./cli
COPY mcp ./mcp
EXPOSE 8789
# ATTESTATION_KEY is deliberately not baked in: pass it at run time from a
# secret manager. Without it the service mints an ephemeral key and says so.
CMD ["node", "server/index.mjs"]
