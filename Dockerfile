FROM node:20-alpine

WORKDIR /app

# Instala git (necessário para o Baileys)
RUN apk add --no-cache git

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]