#!/usr/bin/env bash
#
# hype/dev.sh
#
# Lightweight developer helper script to manage docker-compose services for the Hype project.
#
# Purpose:
#   - Start/stop frontend (vite/pnpm) and backend (playground dev-server)
#   - Run build, docs, tests, and other composer targets defined in docker-compose.yml
#   - Provide a consistent CLI to the existing docker-compose services
#
# Usage:
#   ./dev.sh frontend           # start frontend dev service (detached + follow logs)
#   ./dev.sh backend            # start backend dev service (detached + follow logs)
#   ./dev.sh start              # start frontend+backend for development (attached)
#   ./dev.sh build              # run build service (produces dist)
#   ./dev.sh docs               # run docs generation service
#   ./dev.sh test               # run tests
#   ./dev.sh test-coverage      # run tests w/ coverage
#   ./dev.sh shell              # open interactive shell service
#   ./dev.sh logs [service]     # follow logs (all or a specific service)
#   ./dev.sh down|stop          # stop / remove containers
#   ./dev.sh help               # show this help
#
set -euo pipefail

# Colors
_GREEN=$'\033[0;32m'
_BLUE=$'\033[0;34m'
_YELLOW=$'\033[1;33m'
_RED=$'\033[0;31m'
_NC=$'\033[0m'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.yml"

# Detect docker compose command: prefer `docker compose` if available, else fallback to `docker-compose`
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker-compose"
else
  echo -e "${_RED}ERROR:${_NC} docker compose is not available. Install Docker Desktop or docker-compose."
  exit 1
fi

# Ensure docker daemon is running
if ! docker info >/dev/null 2>&1; then
  echo -e "${_RED}ERROR:${_NC} Docker daemon does not appear to be running."
  echo "Start Docker Desktop / the Docker daemon and try again."
  exit 1
fi

function usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args...]

Commands:
  frontend            Start the frontend dev service (detached) and tail logs
  backend             Start the backend dev service (detached) and tail logs
  start               Start frontend + backend for development (attached)
  build               Run the build service (produces dist)
  docs                Run docs generation service
  test                Run tests
  test-coverage       Run tests with coverage
  shell               Open interactive shell service (container)
  logs [service]      Follow logs (all services if none specified)
  down|stop           Stop and remove containers
  help                Show this help

Examples:
  ./dev.sh frontend
  ./dev.sh backend
  ./dev.sh start
  ./dev.sh build
  ./dev.sh test
  ./dev.sh logs backend

Notes:
  - This script uses the docker-compose file at:
      ${COMPOSE_FILE}
  - The script prefers '${DOCKER_COMPOSE}' as the compose runner.
EOF
}

# Helper: run a docker-compose up for a specific service detached and then follow logs
function up_and_follow() {
  local service=$1
  echo -e "${_BLUE}Starting service:${_NC} ${service}"
  $DOCKER_COMPOSE -f "${COMPOSE_FILE}" up --build -d "${service}"
  echo -e "${_GREEN}Service ${service} is started (detached).${_NC} Following logs now..."
  $DOCKER_COMPOSE -f "${COMPOSE_FILE}" logs -f "${service}"
}

# Helper: run a docker-compose run --rm SERVICE (useful for build/test/docs)
function run_once() {
  local service=$1
  shift || true
  # Safely format remaining arguments without triggering "unbound variable" under strict shell options.
  # Only reference the positional parameters when there are any left.
  if [[ $# -gt 0 ]]; then
    echo -e "${_BLUE}Running service:${_NC} ${service} \"${*}\""
  else
    echo -e "${_BLUE}Running service:${_NC} ${service}"
  fi
  $DOCKER_COMPOSE -f "${COMPOSE_FILE}" run --rm "${service}" "$@"
}

# Main dispatch
if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

COMMAND=$1
shift || true

case "${COMMAND}" in
  frontend)
    # Start frontend dev service detached then tail logs. Service name: dev
    up_and_follow dev
    ;;

  backend)
    # Build the dist artifacts first (so examples can import the Hype runtime)
    # Then copy the built artifacts into the backend's public static path before starting.
    #
    # This keeps the backend serving a practical, usable /static/js/hype.js (and other dist files)
    # without requiring you to manually run the build step.
    echo -e "${_BLUE}Building frontend/library artifacts (dist) before starting backend...${_NC}"
    # Use the helper which runs `docker compose run --rm build` so builds run in the configured service.
    run_once build

    # Copy the produced dist into the playground public static folder so backend serves them.
    DIST_DIR="${ROOT_DIR}/dist"
    TARGET_DIR="${ROOT_DIR}/playground/dev-server/public/static/js"

    if [[ -d "${DIST_DIR}" ]]; then
      echo -e "${_GREEN}Found dist at ${DIST_DIR}. Copying to public static path...${_NC}"
      mkdir -p "${TARGET_DIR}"
      if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete "${DIST_DIR}/" "${TARGET_DIR}/"
      else
        # fallback: copy files safely (avoid unbound-variable failures when glob is empty)
        # enable nullglob so the glob expands to nothing instead of the literal '*'
        # (this avoids errors when DIST_DIR exists but is empty)
        shopt -s nullglob
        for src in "${DIST_DIR}"/*; do
          # ensure we have something to copy; cp will accept files or directories
          cp -a -- "${src}" "${TARGET_DIR}/" 2>/dev/null || true
        done
        # restore default shell behavior
        shopt -u nullglob
      fi
      echo -e "${_GREEN}Artifacts copied to ${TARGET_DIR}.${_NC}"
    else
      echo -e "${_YELLOW}Warning: dist directory not found at ${DIST_DIR}. Backend will start but examples requiring the runtime may 404.${_NC}"
    fi

    echo -e "${_BLUE}Starting backend service now...${_NC}"
    up_and_follow backend
    ;;

  backend-dev)
    # Start backend-dev watcher/build service (runs repo watch/build producing ./dist)
    # This lets the build/watch run inside a container while the backend serves the outputs.
    up_and_follow backend-dev
    ;;

  start)
    # Start both frontend + backend attached so developer sees combined logs
    echo -e "${_BLUE}Starting frontend + backend (attached)...${_NC}"
    # Use --build to ensure latest images. Only bring up the dev frontend (service `dev`)
    # and the backend service to avoid starting other services (tests/build) by default.
    exec $DOCKER_COMPOSE -f "${COMPOSE_FILE}" up --build dev backend
    ;;

  build)
    # Run build target
    run_once build
    ;;

  docs)
    run_once docs
    ;;

  test)
    run_once test
    ;;

  test-coverage)
    run_once test-coverage
    ;;

  shell)
    # Open an interactive shell in the `shell` service
    echo -e "${_BLUE}Opening interactive shell service...${_NC}"
    $DOCKER_COMPOSE -f "${COMPOSE_FILE}" run --rm shell
    ;;

  logs)
    SERVICE=${1:-}
    if [[ -z "${SERVICE}" ]]; then
      echo -e "${_BLUE}Following logs for all services...${_NC}"
      $DOCKER_COMPOSE -f "${COMPOSE_FILE}" logs -f
    else
      echo -e "${_BLUE}Following logs for service: ${SERVICE}${_NC}"
      $DOCKER_COMPOSE -f "${COMPOSE_FILE}" logs -f "${SERVICE}"
    fi
    ;;

  down|stop)
    echo -e "${_YELLOW}Stopping and removing containers...${_NC}"
    $DOCKER_COMPOSE -f "${COMPOSE_FILE}" down
    ;;

  help|--help|-h)
    usage
    ;;

  *)
    echo -e "${_RED}ERROR:${_NC} Unknown command: ${COMMAND}"
    echo
    usage
    exit 2
    ;;
esac
