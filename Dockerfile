# Use a small Node image
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Ensure logs and uploads persist in container filesystem
RUN mkdir -p /usr/src/app/uploads /usr/src/app/screenshots /usr/src/app/public

# If you have a package.json locally, copy it first for better caching
COPY package*.json ./

# If package.json doesn't exist, create one and install required deps
# (express + multer). We use a fallback: if package.json was not copied,
# the next RUN will still install the dependencies.
RUN if [ -f package.json ]; then npm ci --only=production || npm install --only=production; \
    else npm init -y && npm install express multer; fi

# Copy server and all source files (server.js, public folder, etc.)
COPY server.js ./
COPY public ./public

# Create directories used by server (uploads/screenshots)
RUN mkdir -p uploads screenshots

# Expose port 80 (the server reads PORT env var)
ENV PORT=80
EXPOSE 80

# Healthcheck (optional)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O - http://localhost:$PORT/ || exit 1

# Start the server
CMD [ "node", "server.js" ]
