FROM node:24-slim
WORKDIR /app
COPY out ./out
CMD ["node", "out/main/index.js"]
