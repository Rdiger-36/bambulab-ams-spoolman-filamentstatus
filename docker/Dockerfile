# Base Image
FROM node:22-alpine

# Time zone data for TZ, and the tools debug.sh shells out to
RUN apk add --no-cache tzdata mosquitto-clients openssl jq

# Set working directory
WORKDIR /app

# Install the dependencies from the lock file alone, the way the test workflow
# does, so a package that is imported but missing from package.json fails the
# build rather than running on whatever npm would have resolved
COPY package.json package-lock.json ./
RUN mkdir -p /app/logs /app/printers && chmod -R 777 /app/logs /app/printers
RUN npm ci --omit=dev

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
