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
# Default list of services for package-manager helpers.
# Define early to avoid unbound-variable errors when helpers run before later declarations.
DEFAULT_PM_SERVICES=(dev backend build)

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

# Helper: print a short meta header (orange)
function meta() {
  local msg="$*"
  # Print a concise, easily greppable meta line used across helpers
  echo -e "${_YELLOW}-> ${msg}${_NC}"
}

# Helper: run a docker-compose run --rm SERVICE (useful for build/test/docs)
# This wrapper prints a short meta header (orange) indicating the action and offers
# an immediate hint if the command fails so the user can connect to the container.
function run_once() {
  local service=$1
  shift || true
  # Safely format remaining arguments without triggering "unbound variable" under strict shell options.
  # Only reference the positional parameters when there are any left.
  # Meta header for clarity (orange)
  meta "run|enter the ${service}"
  if [[ $# -gt 0 ]]; then
    echo -e "${_BLUE}Running service:${_NC} ${service} \"${*}\""
  else
    echo -e "${_BLUE}Running service:${_NC} ${service}"
  fi

  # Execute and capture exit status to provide helpful hints on failure.
  if ! $DOCKER_COMPOSE -f "${COMPOSE_FILE}" run --rm "${service}" "$@"; then
    local rc=$?
    echo -e "${_YELLOW}hint: if this fails, connect to the container to inspect the environment:${_NC}"
    echo -e "${_YELLOW}  ./dev.sh shell ${service}${_NC}"
    echo -e "${_YELLOW}hint: common issues: missing pnpm/npm in image, missing lockfile, or file permission errors${_NC}"
    return ${rc}
  fi
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
    # Open an interactive shell in a service or run a command inside a service.
    # Usage:
    #   ./dev.sh shell                  -> open interactive shell in service 'shell' (default)
    #   ./dev.sh shell backend          -> open interactive shell in service 'backend'
    #   ./dev.sh shell dev "pnpm i"     -> run 'pnpm i' inside service 'dev' (non-interactive)
    SERVICE="${1:-shell}"
    shift || true
    CMD="$*"

    # If no command supplied and stdin is a TTY, attach / run an interactive shell.
    if [[ -z "${CMD}" ]]; then
      # Prefer attaching to an already-running container via 'exec' if available,
      # otherwise fall back to a one-off 'run --rm -it'.
      echo -e "${_BLUE}Opening interactive shell for service: ${SERVICE}${_NC}"
      # Try to detect if the service has a running container
      if $DOCKER_COMPOSE -f "${COMPOSE_FILE}" ps --quiet "${SERVICE}" >/dev/null 2>&1; then
        # Attach to running container (preserve user when possible)
        echo -e "${_BLUE}Attaching to running container for ${SERVICE}${_NC}"
        # Use 'exec' to attach to the running container; fallback to sh if login shell not available.
        $DOCKER_COMPOSE -f "${COMPOSE_FILE}" exec "${SERVICE}" sh -l || $DOCKER_COMPOSE -f "${COMPOSE_FILE}" exec "${SERVICE}" bash -l || $DOCKER_COMPOSE -f "${COMPOSE_FILE}" exec "${SERVICE}" /bin/sh
      else
        # No running container: run a one-off interactive container with TTY
        echo -e "${_BLUE}No running container found for ${SERVICE}. Starting one-off interactive shell...${_NC}"
        $DOCKER_COMPOSE -f "${COMPOSE_FILE}" run --rm --service-ports -e TERM="${TERM:-xterm-256color}" "${SERVICE}" sh -l || \
          $DOCKER_COMPOSE -f "${COMPOSE_FILE}" run --rm --service-ports -e TERM="${TERM:-xterm-256color}" "${SERVICE}" bash -l || \
          $DOCKER_COMPOSE -f "${COMPOSE_FILE}" run --rm --service-ports -e TERM="${TERM:-xterm-256color}" "${SERVICE}" /bin/sh
      fi
    else
      # Non-interactive: run the provided command inside a transient container
      echo -e "${_BLUE}Running command inside service ${SERVICE}: ${CMD}${_NC}"
      # Use sh -c so the command string is executed by a shell inside the container.
      $DOCKER_COMPOSE -f "${COMPOSE_FILE}" run --rm "${SERVICE}" sh -c "${CMD}"
    fi
    ;;

  update|chore)
    # Run pnpm update across services (or targeted service(s)). Alias: chore
    TARGETS=()
    if [[ $# -gt 0 ]]; then
      TARGETS=("$@")
    else
      TARGETS=("${DEFAULT_PM_SERVICES[@]}")
    fi
    for svc in "${TARGETS[@]}"; do
      meta "pnpm update => ${svc}"
      # try pnpm update; provide hint if it fails
      if run_once "${svc}" pnpm update; then
        echo -e "${_GREEN}pnpm update succeeded for ${svc}.${_NC}"
      else
        echo -e "${_YELLOW}Hint: inspect the container interactively: ./dev.sh shell ${svc}${_NC}"
      fi
    done
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

  audit)
    # Run package-manager audit across the main containers/services.
    # Usage:
    #   ./dev.sh audit           -> runs `pnpm audit` (or `npm audit`) where possible
    #   ./dev.sh audit --fix     -> attempts `pnpm audit fix` / `npm audit fix` where supported
    #
    # This is intentionally best-effort: some images may not have pnpm installed or may
    # not contain a package.json in the expected path. The script will try both pnpm and npm.
    FIX=""
    if [[ "${1:-}" == "--fix" ]]; then
      FIX="--fix"
      shift || true
    fi

    echo -e "${_BLUE}Running audit across services (dev, backend, build). Fix flag: ${FIX}${_NC}"

    # Frontend/dev service: try pnpm first, fall back to npm
    echo -e "${_BLUE}-> Auditing frontend (service: dev)${_NC}"
    run_once dev pnpm audit ${FIX} || run_once dev npm audit ${FIX} || true

    # Backend service: run audit inside container. Some backend images may require a command wrapper.
    echo -e "${_BLUE}-> Auditing backend (service: backend)${_NC}"
    run_once backend sh -c "pnpm audit ${FIX} || npm audit ${FIX}" || true

    # Build service: if present it often has the repository tooling available
    echo -e "${_BLUE}-> Auditing build service (service: build)${_NC}"
    run_once build pnpm audit ${FIX} || run_once build npm audit ${FIX} || true

    echo -e "${_GREEN}Audit complete. Review the output above for vulnerabilities.${_NC}"
    ;;

  install)
    # Run pnpm install (or npm install) inside a service (default: backend).
    # Usage: ./dev.sh install [service]
    SVC="${1:-backend}"
    echo -e "${_YELLOW}-> run|enter the ${SVC} : pnpm install${_NC}"
    if $DOCKER_COMPOSE -f "${COMPOSE_FILE}" ps --quiet "${SVC}" >/dev/null 2>&1; then
      # exec into running container
      $DOCKER_COMPOSE -f "${COMPOSE_FILE}" exec "${SVC}" sh -c "if command -v pnpm >/dev/null 2>&1; then pnpm install || true; elif command -v npm >/dev/null 2>&1; then npm install || true; else echo 'no pnpm/npm in container'; fi" || \
        echo -e "${_YELLOW}hint: connect to ${SVC} -> './dev.sh shell ${SVC}' to inspect and run commands interactively${_NC}"
    else
      # ephemeral run
      $DOCKER_COMPOSE -f "${COMPOSE_FILE}" run --rm "${SVC}" sh -c "if command -v pnpm >/dev/null 2>&1; then pnpm install || true; elif command -v npm >/dev/null 2>&1; then npm install || true; else echo 'no pnpm/npm in image'; fi" || \
        echo -e "${_YELLOW}hint: connect to ${SVC} -> './dev.sh shell ${SVC}' to inspect and run commands interactively${_NC}"
    fi
    ;;

  up)
    # Enhanced: two modes
    #  - ./dev.sh up               -> runs `pnpm update` across default services (safe within semver)
    #  - ./dev.sh up <service...>  -> runs `pnpm update` on the given services
    #  - ./dev.sh up <pkg>         -> runs `pnpm up <pkg>` across default services
    #  - ./dev.sh up <pkg> <svc...>-> runs `pnpm up <pkg>` on the specified services
    if [[ $# -eq 0 ]]; then
      # No args: run `pnpm update` across default pm services
      for svc in "${DEFAULT_PM_SERVICES[@]}"; do
        meta "pnpm update => ${svc}"
        if run_once "${svc}" pnpm update; then
          echo -e "${_GREEN}pnpm update succeeded for ${svc}.${_NC}"
        else
          echo -e "${_YELLOW}Hint: inspect the container interactively: ./dev.sh shell ${svc}${_NC}"
        fi
      done
    else
      # There are args. Interpret first arg as either a package spec (pkg) or a single service name.
      PKG="$1"
      shift || true
      # If remaining args present, they are service targets. Otherwise default to DEFAULT_PM_SERVICES.
      if [[ $# -gt 0 ]]; then
        TARGETS=( "$@" )
      else
        TARGETS=( "${DEFAULT_PM_SERVICES[@]}" )
      fi

      # If the first token looks like a service name and only one arg was provided,
      # treat it as a request to run `pnpm update` on that service.
      if [[ ${#TARGETS[@]} -eq ${#DEFAULT_PM_SERVICES[@]} && " ${DEFAULT_PM_SERVICES[*]} " == *" ${PKG} "* && ${#DEFAULT_PM_SERVICES[@]} -gt 0 && "$#" -eq 0 ]]; then
        # user invoked: ./dev.sh up <service>
        local svc="${PKG}"
        meta "pnpm update => ${svc}"
        if run_once "${svc}" pnpm update; then
          echo -e "${_GREEN}pnpm update succeeded for ${svc}.${_NC}"
        else
          echo -e "${_YELLOW}Hint: inspect the container interactively: ./dev.sh shell ${svc}${_NC}"
        fi
      else
        # Treat first arg as a package spec and run `pnpm up <pkg>` across TARGETS
        for svc in "${TARGETS[@]}"; do
          meta "pnpm up ${PKG} => ${svc}"
          if run_once "${svc}" pnpm up "${PKG}"; then
            echo -e "${_GREEN}pnpm up ${PKG} succeeded in ${svc}.${_NC}"
          else
            echo -e "${_YELLOW}Hint: inspect the container interactively: ./dev.sh shell ${svc}${_NC}"
          fi
        done
      fi
    fi
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
