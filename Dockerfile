FROM node:22-alpine
WORKDIR /app
# Every runtime module (tests are excluded by .dockerignore) plus static assets
COPY package.json *.js index.html ./
COPY assets ./assets
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
