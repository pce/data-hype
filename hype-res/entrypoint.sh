#!/bin/sh
set -e

# Install or sync node_modules inside the container volume
npm install

# Execute the requested CMD from Dockerfile
exec "$@"



