# Node 24 LTS (Node 20 reached end of life). better-sqlite3 compiles from
# source below, so a Node major bump needs no prebuilt binary.
FROM node:24-slim

# Install build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(r.ok)process.exit(0);else process.exit(1)}).catch(()=>process.exit(1))"

# The --import preload resolves Infisical secret:// handles before the app
# loads (no-op unless INFISICAL_RESOLVER_ENABLED=true). This CMD is the only
# start command: the Railway service deliberately has none set.
CMD ["node", "--import", "./src/bootstrap/secrets.js", "src/server.js"]
