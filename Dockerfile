# Base Image
FROM node:18-alpine

# Zeitdaten und Zeitzone installieren und festlegen
RUN apk update && apk add --no-cache tzdata mosquitto-clients openssl jq

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN mkdir -p /app/logs /app/printers /app/certs && chmod -R 777 /app/logs /app/printers /app/certs
RUN npm install

# Copy application code
COPY . .

# Make the script executable
RUN chmod +x /app/scripts/debug.sh

# Create an alias for the script
RUN ln -s /app/scripts/debug.sh /usr/local/bin/debug-printers

# Expose port 4000 for the backend
EXPOSE 4000

# Start the backend
CMD ["node", "backend.js"]
