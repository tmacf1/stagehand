#!/bin/bash

set -euo pipefail

DEFAULT_STAGEHAND_PROJECT_DIR="/Users/taozi/gocode/stagehand"
EXAMPLE_NAME="wechat_video_draft"

STAGEHAND_PROJECT_DIR="${STAGEHAND_PROJECT_DIR:-$DEFAULT_STAGEHAND_PROJECT_DIR}"
DRY_RUN=false

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log_info() {
  printf '[INFO] %s\n' "$1"
}

log_error() {
  printf '[ERROR] %s\n' "$1" >&2
}

show_help() {
  cat <<'EOF'
Usage: run_wechat_video_draft.sh [OPTIONS]

Runs the Stagehand WeChat Channels draft example:
  pnpm example wechat_video_draft

OPTIONS:
  --stagehand-dir DIR  Override the Stagehand project directory
  --upload-dir DIR     Export WECHAT_VIDEO_UPLOAD_DIR
  --topic TEXT         Export WECHAT_VIDEO_TOPIC
  --model MODEL        Export STAGEHAND_MODEL_NAME
  --profile-dir DIR    Export WECHAT_VIDEO_PROFILE_DIR
  --profile NAME       Export WECHAT_VIDEO_PROFILE_DIRECTORY
  --auto-close         Export WECHAT_VIDEO_AUTO_CLOSE=1
  --dry-run            Print the resolved command without running it
  -h, --help           Show this help

ENVIRONMENT:
  STAGEHAND_PROJECT_DIR
  WECHAT_VIDEO_UPLOAD_DIR
  WECHAT_VIDEO_TOPIC
  STAGEHAND_MODEL_NAME
  WECHAT_VIDEO_PROFILE_DIR
  WECHAT_VIDEO_PROFILE_DIRECTORY
  WECHAT_VIDEO_AUTO_CLOSE
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stagehand-dir)
      [[ $# -ge 2 ]] || { log_error "--stagehand-dir requires a value"; exit 1; }
      STAGEHAND_PROJECT_DIR="$2"
      shift 2
      ;;
    --upload-dir)
      [[ $# -ge 2 ]] || { log_error "--upload-dir requires a value"; exit 1; }
      export WECHAT_VIDEO_UPLOAD_DIR="$2"
      shift 2
      ;;
    --topic)
      [[ $# -ge 2 ]] || { log_error "--topic requires a value"; exit 1; }
      export WECHAT_VIDEO_TOPIC="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || { log_error "--model requires a value"; exit 1; }
      export STAGEHAND_MODEL_NAME="$2"
      shift 2
      ;;
    --profile-dir)
      [[ $# -ge 2 ]] || { log_error "--profile-dir requires a value"; exit 1; }
      export WECHAT_VIDEO_PROFILE_DIR="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || { log_error "--profile requires a value"; exit 1; }
      export WECHAT_VIDEO_PROFILE_DIRECTORY="$2"
      shift 2
      ;;
    --auto-close)
      export WECHAT_VIDEO_AUTO_CLOSE="1"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      show_help
      exit 1
      ;;
  esac
done

if [[ ! -d "$STAGEHAND_PROJECT_DIR" ]]; then
  log_error "Stagehand project directory not found: $STAGEHAND_PROJECT_DIR"
  exit 1
fi

if [[ ! -f "$STAGEHAND_PROJECT_DIR/package.json" ]]; then
  log_error "package.json not found in: $STAGEHAND_PROJECT_DIR"
  exit 1
fi

if [[ ! -f "$STAGEHAND_PROJECT_DIR/packages/core/examples/${EXAMPLE_NAME}.ts" ]]; then
  log_error "Example file not found: $STAGEHAND_PROJECT_DIR/packages/core/examples/${EXAMPLE_NAME}.ts"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  log_error "pnpm is not installed or not available in PATH"
  exit 1
fi

log_info "Stagehand project: $STAGEHAND_PROJECT_DIR"
log_info "Command: pnpm example $EXAMPLE_NAME"

if [[ -n "${WECHAT_VIDEO_UPLOAD_DIR:-}" ]]; then
  log_info "WECHAT_VIDEO_UPLOAD_DIR=$WECHAT_VIDEO_UPLOAD_DIR"
fi

if [[ -n "${WECHAT_VIDEO_TOPIC:-}" ]]; then
  log_info "WECHAT_VIDEO_TOPIC=$WECHAT_VIDEO_TOPIC"
fi

if [[ -n "${STAGEHAND_MODEL_NAME:-}" ]]; then
  log_info "STAGEHAND_MODEL_NAME=$STAGEHAND_MODEL_NAME"
fi

if [[ "$DRY_RUN" == true ]]; then
  exit 0
fi

cd "$STAGEHAND_PROJECT_DIR"
exec pnpm example "$EXAMPLE_NAME"
