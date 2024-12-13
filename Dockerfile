# Stage 1: Build dependencies
FROM node:18 as build

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

# Stage 2: Final image
FROM node:18-alpine

WORKDIR /app
COPY --from=build /app .

# Set environment variables
ENV PRINTER_ID="serial"
ENV PRINTER_CODE="accesscode"
ENV PRINTER_IP="127.0.0.1"
ENV SPOOLMAN_IP="127.0.0.1"
ENV SPOOLMAN_PORT="12345"

CMD ["node", "filament_status.js"]