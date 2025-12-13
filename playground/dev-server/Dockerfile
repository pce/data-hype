# Dev Dockerfile for Hype playground dev-server (TypeScript + Node)
# Purpose: build a self-contained dev-server image that contains compiled JS
# so runtime doesn't rely on mounting the source tree over the build output.
#
# Build context: hype/playground/dev-server
# Typical usage (from repo root):
#   docker build -t hype-backend -f hype/playground/dev-server/Dockerfile hype/playground/dev-server
#   docker run --rm -p 3000:3000 hype-backend
#
FROM node:20-alpine

# Keep image small but install common build tools needed by native deps
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    libc6-compat \
    bash \
    && npm install -g pnpm@latest

# Use a dedicated app directory that will hold the built artifacts.
# This avoids accidental overwrites when someone mounts a host path at /app.
WORKDIR /usr/src/app

# Copy only package manifests first to leverage docker layer caching
COPY package.json pnpm-lock.yaml* tsconfig.json* ./

# Install dependencies but don't run install scripts yet (we'll run build after copying sources).
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Copy source files into the image and build the project to produce `dist/`.
COPY . .

# Build Tailwind CSS so example pages can reference /tailwind.css.
# This runs the `build:css` npm script defined in playground/dev-server/package.json
# (produces `public/tailwind.css`). We allow the command to fail harmlessly in
# minimal environments where the binary might not be present, but in CI/docker
# the devDependencies include Tailwind so this will run successfully.
RUN pnpm run build:css || true

# Build the TypeScript output into dist/
RUN pnpm run build

# Expose dev port
EXPOSE 3000

# Run the compiled JS to serve the examples. This keeps runtime simple and avoids ts-node ESM issues.
ENV NODE_ENV=production
CMD ["pnpm", "run", "start"]
