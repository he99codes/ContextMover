#!/usr/bin/env bash
# Usage: ./packages/browser-extension/scripts/release.sh 1.0.1
# Bumps manifest.json, commits, tags, and pushes — CI does the rest.

set -e

VERSION="${1:?Usage: release.sh <version> e.g. 1.0.1}"
MANIFEST="packages/browser-extension/manifest.json"
ROOT="$(git rev-parse --show-toplevel)"

cd "$ROOT"

# ── Validate semver ──────────────────────────────────────────────────────────
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: version must be semver (e.g. 1.0.1)"
  exit 1
fi

# ── Bump manifest.json ───────────────────────────────────────────────────────
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$MANIFEST','utf8'));
  m.version = '$VERSION';
  fs.writeFileSync('$MANIFEST', JSON.stringify(m, null, 4) + '\n');
  console.log('manifest.json → ' + m.version);
"

# ── Commit + tag + push ──────────────────────────────────────────────────────
git add "$MANIFEST"
git commit -m "chore: bump extension to $VERSION"
git tag "ext-v$VERSION"
git push origin main --tags

echo ""
echo "✓ Tagged ext-v$VERSION and pushed."
echo "  GitHub Actions will build, test, publish to Chrome Web Store,"
echo "  and update extension-version.json automatically."
