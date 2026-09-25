FROM node:23-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000 5173

ENTRYPOINT ["/app/entrypoint.sh"]
# CMD ["npm", "run", "res:dev"]
CMD ["bash"]
