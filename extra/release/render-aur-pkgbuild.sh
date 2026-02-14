#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage:
  render-aur-pkgbuild.sh --tag <vX.Y.Z> --repo <owner/repo> \
    --checksums <SHA256SUMS> [--pkgname lectic-bin] [--srcinfo]
USAGE
}

TAG=""
REPO=""
CHECKSUMS=""
PKGNAME="lectic-bin"
MODE="pkgbuild"

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
    --pkgname)
      PKGNAME="${2:-}"
      shift 2
      ;;
    --srcinfo)
      MODE="srcinfo"
      shift
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

LINUX_X64_FILE="lectic-${TAG}-linux-x86_64.tar.gz"
LINUX_ARM_FILE="lectic-${TAG}-linux-aarch64.tar.gz"

LINUX_X64_SHA="$(sha_for "$LINUX_X64_FILE")"
LINUX_ARM_SHA="$(sha_for "$LINUX_ARM_FILE")"

if [[ -z "$LINUX_X64_SHA" || -z "$LINUX_ARM_SHA" ]]; then
  echo "Missing one or more required checksums in $CHECKSUMS" >&2
  exit 1
fi

if [[ "$MODE" == "srcinfo" ]]; then
  cat <<EOF
pkgbase = ${PKGNAME}
	pkgdesc = unixy LLM toolbox
	pkgver = ${VERSION}
	pkgrel = 1
	url = https://github.com/${REPO}
	arch = x86_64
	arch = aarch64
	license = MIT
	depends = glibc
	depends = gcc-libs
	source_x86_64 = ${LINUX_X64_FILE}::${BASE_URL}/${LINUX_X64_FILE}
	source_aarch64 = ${LINUX_ARM_FILE}::${BASE_URL}/${LINUX_ARM_FILE}
	sha256sums_x86_64 = ${LINUX_X64_SHA}
	sha256sums_aarch64 = ${LINUX_ARM_SHA}

pkgname = ${PKGNAME}
EOF
  exit 0
fi

cat <<EOF
pkgname=${PKGNAME}
pkgver=${VERSION}
pkgrel=1
pkgdesc='unixy LLM toolbox'
arch=('x86_64' 'aarch64')
url='https://github.com/${REPO}'
license=('MIT')
depends=('glibc' 'gcc-libs')
source_x86_64=(
  "${LINUX_X64_FILE}::${BASE_URL}/${LINUX_X64_FILE}"
)
source_aarch64=(
  "${LINUX_ARM_FILE}::${BASE_URL}/${LINUX_ARM_FILE}"
)
sha256sums_x86_64=('${LINUX_X64_SHA}')
sha256sums_aarch64=('${LINUX_ARM_SHA}')

package() {
  install -Dm755 "\${srcdir}/lectic" "\${pkgdir}/usr/bin/lectic"
}
EOF
