FROM node:20-slim

# Install python and build tools required for node-gyp (sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root config
COPY package*.json ./

# Copy workspace package.jsons to cache dependencies
COPY packages/core/package.json ./packages/core/
COPY packages/bots/dlmm-bot/package.json ./packages/bots/dlmm-bot/

# Install dependencies across workspaces
RUN npm install

# Copy remaining source code
COPY . .

# Build the SDK and Bot
RUN npm run build --workspaces

# Run the DLMM Bot
CMD ["npm", "run", "start", "-w", "@autoland/dlmm-bot"]
