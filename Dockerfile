# Hype Build Dockerfile
# Provides a reproducible Node.js environment for building the project

FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install build dependencies and pnpm
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ && \
    npm install -g pnpm@latest

# Copy package files first (for better caching)
COPY package.json ./

# Install dependencies
RUN pnpm install --no-frozen-lockfile

# Copy configuration files
COPY tsconfig.json ./
COPY vitest.config.ts ./
COPY typedoc.json ./
COPY typedoc-theme.css ./

# Copy source code
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
COPY README.md ./

# Set environment
ENV NODE_ENV=production

# Build the project
RUN pnpm run build

# Verify build
RUN ls -lah dist/

# Default command
CMD ["pnpm", "run", "build"]

# Volume for output
VOLUME ["/app/dist"]

# Metadata
LABEL maintainer="pce"
LABEL description="Build container for Hype - Progressive Enhancement Library"
LABEL version="0.1.0"
