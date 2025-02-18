# Base Image
FROM node:18-alpine

# install packahe to set time from ENV
RUN apk update && apk add --no-cache tzdata

# Set working directory
WORKDIR /app

# Copy package files, set needed dirs and install dependencies
COPY package.json package-lock.json ./
RUN mkdir -p /app/logs /app/printers && chmod -R 777 /app/logs /app/printers
RUN npm install

# Copy application code
COPY . .

# Expose port 4000 for the backend
EXPOSE 4000

# Start the backend
CMD ["node", "backend.js"]
