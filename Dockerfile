# Base Image
FROM node:22-alpine

# Install time zone data and set the time zone
RUN apk update && apk add --no-cache tzdata mosquitto-clients openssl jq

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN mkdir -p /app/logs /app/printers && chmod -R 777 /app/logs /app/printers
RUN npm install

# Copy application code
COPY . .

# Make the script executable
RUN chmod +x /app/scripts/debug.sh

# Create an alias for the script
RUN ln -s /app/scripts/debug.sh /usr/local/bin/debug-printers

# Which name this image is published under. An image cannot see the tag it
# was pulled by, so the name is baked in: Dockerfile.legacy builds the image of
# the old name on top of this one and overrides it, which is what lets the
# service say that the old name is deprecated.
ENV HASPELSYNC_IMAGE=haspelsync

# Expose port 4000 for the backend
EXPOSE 4000

# Start the backend
CMD ["node", "entrypoint.js"]
