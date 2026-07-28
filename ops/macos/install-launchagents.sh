#!/bin/sh

set -eu

usage() {
  printf '%s\n' \
    "Usage: conda activate pad" \
    "       ./ops/macos/install-launchagents.sh [--include-cloudflared] [--skip-ollama] [--skip-mlx-audio] [--skip-gateway] [--replace]" \
    "" \
    "Installs user LaunchAgents for Ollama, MLX-Audio, and the PAD gateway." \
    "Cloudflared is opt-in and reads its token from an existing mode-600 file." \
    "Existing plist files are never replaced unless --replace is supplied."
}

fail() {
  printf 'install-launchagents: %s\n' "$1" >&2
  exit 1
}

include_cloudflared=0
include_gateway=1
include_mlx_audio=1
include_ollama=1
replace_existing=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --include-cloudflared)
      include_cloudflared=1
      ;;
    --skip-gateway)
      include_gateway=0
      ;;
    --skip-mlx-audio)
      include_mlx_audio=0
      ;;
    --skip-ollama)
      include_ollama=0
      ;;
    --replace)
      replace_existing=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
  shift
done

[ "${CONDA_DEFAULT_ENV:-}" = "pad" ] ||
  fail "activate the pad Conda environment before running this helper."
[ -n "${CONDA_PREFIX:-}" ] ||
  fail "CONDA_PREFIX is unavailable in the active pad environment."

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
web_root=$(CDPATH= cd -- "$script_directory/../.." && pwd)
template_directory="$script_directory/launchagents"
launch_agent_directory="$HOME/Library/LaunchAgents"
runtime_directory="$web_root/.runtime/tutor-gateway"
log_directory="$runtime_directory/logs"
gateway_token_file="$runtime_directory/gateway-token.txt"
cloudflared_token_file="$runtime_directory/cloudflared-token.txt"
domain_target="gui/$(id -u)"

node_bin=$(command -v node || true)
python_bin="$CONDA_PREFIX/bin/python"
mlx_audio_wrapper="$web_root/scripts/mlx-audio-server.py"
ollama_bin=$(command -v ollama || true)
cloudflared_bin=""

[ "$include_gateway" -eq 0 ] ||
  [ -n "$node_bin" ] ||
  fail "node is not available in the active pad environment."
[ "$include_mlx_audio" -eq 0 ] ||
  [ -x "$python_bin" ] ||
  fail "python is not available in the active pad environment."
[ "$include_mlx_audio" -eq 0 ] ||
  [ -r "$mlx_audio_wrapper" ] ||
  fail "scripts/mlx-audio-server.py is unavailable."
[ "$include_ollama" -eq 0 ] ||
  [ -n "$ollama_bin" ] ||
  fail "ollama is not available on PATH."
[ "$include_gateway" -eq 0 ] ||
  [ -s "$gateway_token_file" ] ||
  fail "create .runtime/tutor-gateway/gateway-token.txt before installation."

if [ "$include_cloudflared" -eq 1 ]; then
  cloudflared_bin=$(command -v cloudflared || true)
  [ -n "$cloudflared_bin" ] || fail "cloudflared is not available on PATH."
  [ -s "$cloudflared_token_file" ] ||
    fail "create .runtime/tutor-gateway/cloudflared-token.txt before installation."
  if [ -e "$HOME/Library/LaunchAgents/com.cloudflare.cloudflared.plist" ] ||
    [ -e "/Library/LaunchDaemons/com.cloudflare.cloudflared.plist" ]; then
    fail "an existing Cloudflare LaunchAgent/Daemon must be reviewed before adding another connector."
  fi
fi

for value in \
  "$HOME" \
  "$CONDA_PREFIX" \
  "$web_root" \
  "$log_directory" \
  "$gateway_token_file" \
  "$cloudflared_token_file" \
  "$node_bin" \
  "$python_bin" \
  "$mlx_audio_wrapper" \
  "$ollama_bin" \
  "$cloudflared_bin"
do
  case "$value" in
    *'&'*|*'<'*|*'>'*|*'|'*)
      fail "installation paths cannot contain XML-reserved characters or |."
      ;;
  esac
done

umask 077
mkdir -p "$launch_agent_directory" "$runtime_directory" "$log_directory"
chmod 700 "$runtime_directory" "$log_directory"
if [ "$include_gateway" -eq 1 ]; then
  chmod 600 "$gateway_token_file"
fi
if [ "$include_cloudflared" -eq 1 ]; then
  chmod 600 "$cloudflared_token_file"
fi

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/pad-launchagents.XXXXXX")
cleanup() {
  case "$temporary_directory" in
    "${TMPDIR:-/tmp}"/pad-launchagents.*)
      rm -r "$temporary_directory"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

render_template() {
  template_path="$1"
  output_path="$2"
  sed \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PAD_ENV_PREFIX__|$CONDA_PREFIX|g" \
    -e "s|__WEB_ROOT__|$web_root|g" \
    -e "s|__LOG_DIRECTORY__|$log_directory|g" \
    -e "s|__GATEWAY_TOKEN_FILE__|$gateway_token_file|g" \
    -e "s|__CLOUDFLARED_TOKEN_FILE__|$cloudflared_token_file|g" \
    -e "s|__NODE_BIN__|$node_bin|g" \
    -e "s|__PYTHON_BIN__|$python_bin|g" \
    -e "s|__OLLAMA_BIN__|$ollama_bin|g" \
    -e "s|__CLOUDFLARED_BIN__|$cloudflared_bin|g" \
    "$template_path" >"$output_path"
  plutil -lint "$output_path" >/dev/null
}

prepare_agent() {
  label="$1"
  source_path="$template_directory/$label.plist.example"
  rendered_path="$temporary_directory/$label.plist"
  target_path="$launch_agent_directory/$label.plist"

  [ -f "$source_path" ] || fail "missing template for $label."
  if [ -e "$target_path" ] && [ "$replace_existing" -ne 1 ]; then
    fail "$target_path already exists; inspect it or rerun with --replace."
  fi
  render_template "$source_path" "$rendered_path"
}

install_agent() {
  label="$1"
  rendered_path="$temporary_directory/$label.plist"
  target_path="$launch_agent_directory/$label.plist"

  if [ "$replace_existing" -eq 1 ]; then
    launchctl bootout "$domain_target/$label" >/dev/null 2>&1 || true
  fi
  install -m 600 "$rendered_path" "$target_path"
  launchctl bootstrap "$domain_target" "$target_path"
  printf 'Installed %s\n' "$label"
}

if [ "$include_ollama" -eq 1 ]; then
  prepare_agent "com.pineatdawn.tutor.ollama"
fi
if [ "$include_mlx_audio" -eq 1 ]; then
  prepare_agent "com.pineatdawn.tutor.mlx-audio"
fi
if [ "$include_gateway" -eq 1 ]; then
  prepare_agent "com.pineatdawn.tutor.gateway"
fi
if [ "$include_cloudflared" -eq 1 ]; then
  prepare_agent "com.pineatdawn.tutor.cloudflared"
fi

if [ "$include_ollama" -eq 1 ]; then
  install_agent "com.pineatdawn.tutor.ollama"
fi
if [ "$include_mlx_audio" -eq 1 ]; then
  install_agent "com.pineatdawn.tutor.mlx-audio"
fi
if [ "$include_gateway" -eq 1 ]; then
  install_agent "com.pineatdawn.tutor.gateway"
fi
if [ "$include_cloudflared" -eq 1 ]; then
  install_agent "com.pineatdawn.tutor.cloudflared"
fi

printf '%s\n' \
  "LaunchAgents installed. Check status with:"
if [ "$include_mlx_audio" -eq 1 ]; then
  printf '%s\n' \
    "  launchctl print $domain_target/com.pineatdawn.tutor.mlx-audio"
fi
if [ "$include_gateway" -eq 1 ]; then
  printf '%s\n' \
    "  launchctl print $domain_target/com.pineatdawn.tutor.gateway"
fi
