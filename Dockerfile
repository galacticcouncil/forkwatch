FROM node:22-alpine

WORKDIR /app

COPY package.json yarn.lock* ./
RUN npm install --production

COPY src/ ./src/

EXPOSE 3001

CMD ["node", "--max-old-space-size=4096", "src/index.js"]
