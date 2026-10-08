FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY scripts ./scripts
COPY seed ./seed
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "scripts/start.js"]
