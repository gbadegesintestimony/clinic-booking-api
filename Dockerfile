FROM node:22.16.0-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
ENV PORT=3000
ENV API_KEY=koya-clinic-key-2026
CMD ["node", "src/server.js"]

