#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage:
  release.sh <version> [--push]

Examples:
  ./extra/release/release.sh 0.0.2
  ./extra/release/release.sh 0.0.2 --push

What it does:
  - updates package.json and package-lock.json version
  - changes CHANGELOG header for the version from
    "## v<version> - unreleased" to "## v<version> - <YYYY-MM-DD>"
  - creates commit "Release v<version>"
  - creates tag "v<version>"
  - optionally pushes commit and tag when --push is set
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

VERSION=""
PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)
      PUSH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must match X.Y.Z (got: $VERSION)" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Refusing to release from branch '$CURRENT_BRANCH' (expected main)." >&2
  exit 1
fi

if [[ -n "$(git ls-remote --tags origin "refs/tags/v${VERSION}")" ]]; then
  echo "Tag v${VERSION} already exists on origin." >&2
  exit 1
fi

if [[ -n "$(git tag -l "v${VERSION}")" ]]; then
  echo "Tag v${VERSION} already exists locally." >&2
  exit 1
fi

if ! grep -q "^## v${VERSION} - unreleased$" CHANGELOG.md; then
  echo "Missing changelog header: ## v${VERSION} - unreleased" >&2
  exit 1
fi

export VERSION
node <<'NODE'
const fs = require("fs");

const version = process.env.VERSION;
const files = ["package.json", "package-lock.json"];

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  data.version = version;
  if (data.packages && data.packages[""]) {
    data.packages[""].version = version;
  }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
NODE

RELEASE_DATE="$(date -u +%Y-%m-%d)"
export RELEASE_DATE
node <<'NODE'
const fs = require("fs");

const version = process.env.VERSION;
const releaseDate = process.env.RELEASE_DATE;
const oldHeader = `## v${version} - unreleased`;
const newHeader = `## v${version} - ${releaseDate}`;

const path = "CHANGELOG.md";
const content = fs.readFileSync(path, "utf8");
if (!content.includes(oldHeader)) {
  throw new Error(`Missing changelog header: ${oldHeader}`);
}
fs.writeFileSync(path, content.replace(oldHeader, newHeader), "utf8");
NODE

git add package.json package-lock.json CHANGELOG.md
git commit -m "Release v${VERSION}"
git tag "v${VERSION}"

if [[ "$PUSH" -eq 1 ]]; then
  git push origin HEAD
  git push origin "v${VERSION}"
  echo "Released and pushed v${VERSION}."
else
  echo "Created commit and tag locally."
  echo "To publish:"
  echo "  git push origin HEAD"
  echo "  git push origin v${VERSION}"
fi
