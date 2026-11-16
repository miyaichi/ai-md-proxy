FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
