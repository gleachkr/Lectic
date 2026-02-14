#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage:
  render-homebrew-formula.sh --tag <vX.Y.Z> --repo <owner/repo> \
    --checksums <SHA256SUMS>
USAGE
}

TAG=""
REPO=""
CHECKSUMS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --checksums)
      CHECKSUMS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TAG" || -z "$REPO" || -z "$CHECKSUMS" ]]; then
  usage
  exit 1
fi

if [[ ! -f "$CHECKSUMS" ]]; then
  echo "Missing checksums file: $CHECKSUMS" >&2
  exit 1
fi

VERSION="${TAG#v}"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

sha_for() {
  local file="$1"
  awk -v file="$file" '$2 == file { print $1 }' "$CHECKSUMS"
}

DARWIN_ARM_FILE="lectic-${TAG}-darwin-aarch64.tar.gz"
DARWIN_X64_FILE="lectic-${TAG}-darwin-x86_64.tar.gz"
LINUX_ARM_FILE="lectic-${TAG}-linux-aarch64.tar.gz"
LINUX_X64_FILE="lectic-${TAG}-linux-x86_64.tar.gz"

DARWIN_ARM_SHA="$(sha_for "$DARWIN_ARM_FILE")"
DARWIN_X64_SHA="$(sha_for "$DARWIN_X64_FILE")"
LINUX_ARM_SHA="$(sha_for "$LINUX_ARM_FILE")"
LINUX_X64_SHA="$(sha_for "$LINUX_X64_FILE")"

for value in \
  "$DARWIN_ARM_SHA" \
  "$DARWIN_X64_SHA" \
  "$LINUX_ARM_SHA" \
  "$LINUX_X64_SHA"
do
  if [[ -z "$value" ]]; then
    echo "Missing one or more required checksums in $CHECKSUMS" >&2
    exit 1
  fi
done

cat <<EOF
class Lectic < Formula
  desc "Unixy LLM toolbox"
  homepage "https://github.com/${REPO}"
  version "${VERSION}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${BASE_URL}/${DARWIN_ARM_FILE}"
      sha256 "${DARWIN_ARM_SHA}"
    else
      url "${BASE_URL}/${DARWIN_X64_FILE}"
      sha256 "${DARWIN_X64_SHA}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${BASE_URL}/${LINUX_ARM_FILE}"
      sha256 "${LINUX_ARM_SHA}"
    else
      url "${BASE_URL}/${LINUX_X64_FILE}"
      sha256 "${LINUX_X64_SHA}"
    end
  end

  def install
    bin.install "lectic"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/lectic --version")
  end
end
EOF
