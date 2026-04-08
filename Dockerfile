FROM node:22-alpine

WORKDIR /app

COPY package.json yarn.lock* ./
RUN npm install --production

COPY src/ ./src/

EXPOSE 3001

CMD ["node", "src/index.js"]
