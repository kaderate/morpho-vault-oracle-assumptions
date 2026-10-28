FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY registry ./registry
ENV NODE_ENV=production
EXPOSE 3000
# tsx runs the TypeScript directly: no build step for a service this size.
CMD ["node", "--import", "tsx", "src/main.ts"]
