FROM ghcr.io/puppeteer/puppeteer:21.6.1

WORKDIR /app

COPY package*.json ./

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci --only=production

COPY . .

EXPOSE 3000

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

CMD ["node", "server.js"]
