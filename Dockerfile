FROM node:22-alpine
WORKDIR /app
COPY package.json engine.js server.js index.html ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
