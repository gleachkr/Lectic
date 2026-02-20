#!/bin/sh
set -eu

REPO="${LECTIC_INSTALL_REPO:-gleachkr/lectic}"
VERSION_INPUT="latest"
BIN_DIR=""

info() {
  printf '%s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install Lectic from GitHub releases.

Usage:
  install.sh [options]
  install.sh [version]

Examples:
  curl -fsSL https://raw.githubusercontent.com/gleachkr/lectic/main/install.sh \
    | sh
  curl -fsSL https://raw.githubusercontent.com/gleachkr/lectic/main/install.sh \
    | sh -s -- --version v0.0.2

Options:
  --version <version>   Release version (vX.Y.Z, X.Y.Z, or latest)
  --repo <owner/repo>   GitHub repository (default: gleachkr/lectic)
  --bin-dir <dir>       Install directory for the lectic binary
  -h, --help            Show this help

Notes:
  - Defaults to the latest release.
  - To update, run the installer again.
EOF
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

download_file() {
  url="$1"
  out="$2"

  if have_cmd curl; then
    curl --fail --silent --show-error --location "$url" --output "$out"
    return
  fi

  if have_cmd wget; then
    wget -qO "$out" "$url"
    return
  fi

  die "need curl or wget installed"
}

download_text() {
  url="$1"

  if have_cmd curl; then
    curl --fail --silent --show-error --location "$url"
    return
  fi

  if have_cmd wget; then
    wget -qO- "$url"
    return
  fi

  die "need curl or wget installed"
}

create_temp_dir() {
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/lectic-install.XXXXXX" 2>/dev/null || true)"

  if [ -z "$tmp_dir" ]; then
    tmp_dir="$(mktemp -d -t lectic-install)"
  fi

  printf '%s\n' "$tmp_dir"
}

normalize_os() {
  os_raw="$(uname -s)"
  case "$os_raw" in
    Linux)
      printf 'linux\n'
      ;;
    Darwin)
      printf 'darwin\n'
      ;;
    *)
      die "unsupported operating system: $os_raw"
      ;;
  esac
}

normalize_arch() {
  arch_raw="$(uname -m)"
  case "$arch_raw" in
    x86_64|amd64)
      printf 'x86_64\n'
      ;;
    arm64|aarch64)
      printf 'aarch64\n'
      ;;
    *)
      die "unsupported architecture: $arch_raw"
      ;;
  esac
}

default_bin_dir() {
  if [ "$(id -u)" -eq 0 ]; then
    printf '/usr/local/bin\n'
  else
    printf '%s/.local/bin\n' "$HOME"
  fi
}

normalize_tag() {
  raw="$1"

  if [ "$raw" = "latest" ]; then
    api_url="https://api.github.com/repos/$REPO/releases/latest"
    json="$(download_text "$api_url")"
    compact_json="$(printf '%s' "$json" | tr -d '\n')"
    tag="$(printf '%s' "$compact_json" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

    if [ -z "$tag" ]; then
      die "failed to resolve latest release tag from $api_url"
    fi

    printf '%s\n' "$tag"
    return
  fi

  case "$raw" in
    v*)
      printf '%s\n' "$raw"
      ;;
    *)
      printf 'v%s\n' "$raw"
      ;;
  esac
}

verify_checksum_if_possible() {
  tarball_path="$1"
  tarball_name="$2"
  checksums_path="$3"

  expected="$(awk -v target="$tarball_name" \
    '$2 == target { print $1; exit }' "$checksums_path")"

  if [ -z "$expected" ]; then
    warn "could not find checksum for $tarball_name in SHA256SUMS"
    return
  fi

  if have_cmd sha256sum; then
    actual="$(sha256sum "$tarball_path" | awk '{print $1}')"
  elif have_cmd shasum; then
    actual="$(shasum -a 256 "$tarball_path" | awk '{print $1}')"
  else
    warn "sha256sum/shasum missing; skipping checksum verification"
    return
  fi

  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $tarball_name"
  fi
}

install_file_755() {
  src="$1"
  dest="$2"

  dest_dir="$(dirname "$dest")"
  mkdir -p "$dest_dir"

  if have_cmd install; then
    install -m 755 "$src" "$dest"
  else
    cp "$src" "$dest"
    chmod 755 "$dest"
  fi
}

resolve_binary_from_extract() {
  extract_dir="$1"
  arch="$2"

  if [ -f "$extract_dir/lectic" ]; then
    printf '%s\n' "$extract_dir/lectic"
    return
  fi

  if [ -f "$extract_dir/lectic-$arch" ]; then
    printf '%s\n' "$extract_dir/lectic-$arch"
    return
  fi

  candidate="$(find "$extract_dir" -maxdepth 2 -type f -name 'lectic*' \
    2>/dev/null | head -n 1)"

  if [ -n "$candidate" ]; then
    printf '%s\n' "$candidate"
    return
  fi

  die "could not find extracted lectic binary"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION_INPUT="$2"
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || die "--repo requires a value"
      REPO="$2"
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || die "--bin-dir requires a value"
      BIN_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      if [ "$VERSION_INPUT" = "latest" ]; then
        VERSION_INPUT="$1"
        shift
      else
        die "unexpected argument: $1"
      fi
      ;;
  esac
done

[ "$#" -eq 0 ] || die "unexpected arguments: $*"

os="$(normalize_os)"
arch="$(normalize_arch)"

if [ -z "$BIN_DIR" ]; then
  BIN_DIR="$(default_bin_dir)"
fi

tag="$(normalize_tag "$VERSION_INPUT")"
asset_name="lectic-${tag}-${os}-${arch}.tar.gz"
release_base="https://github.com/${REPO}/releases/download/${tag}"
asset_url="${release_base}/${asset_name}"
checksums_url="${release_base}/SHA256SUMS"

tmp_dir="$(create_temp_dir)"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

tarball_path="$tmp_dir/$asset_name"
checksums_path="$tmp_dir/SHA256SUMS"
extract_dir="$tmp_dir/extracted"

info "Installing Lectic ${tag} for ${os}/${arch} from ${REPO}"

if ! download_file "$asset_url" "$tarball_path"; then
  die "failed to download release asset: $asset_url"
fi

if download_file "$checksums_url" "$checksums_path"; then
  verify_checksum_if_possible "$tarball_path" "$asset_name" "$checksums_path"
else
  warn "could not download SHA256SUMS; skipping checksum verification"
fi

mkdir -p "$extract_dir"
tar -xzf "$tarball_path" -C "$extract_dir"

binary_path="$(resolve_binary_from_extract "$extract_dir" "$arch")"
install_file_755 "$binary_path" "$BIN_DIR/lectic"

info "Installed: $BIN_DIR/lectic"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    ;;
  *)
    warn "$BIN_DIR is not on PATH in this shell"
    warn "add it, then reopen your shell"
    ;;
esac

info "Done."
info "Run: lectic --version"
info "Update later by rerunning:"
info "  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh"
