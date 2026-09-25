#!/usr/bin/env bash
# release-1.6.0.sh — fixed release path for v1.6.0
set -euo pipefail

cd /Users/jun/Developer/new/700_projects/cli-jaw

TARGET_VERSION="1.6.0"
EXPECTED_CURRENT="1.5.1"

echo "🦈 cli-jaw fixed release script"
echo "==============================="
echo "Current expected version: $EXPECTED_CURRENT"
echo "Target version:           $TARGET_VERSION"

CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [[ "$CURRENT_VERSION" != "$EXPECTED_CURRENT" ]]; then
  echo "❌ Expected package.json version $EXPECTED_CURRENT but found $CURRENT_VERSION"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Working tree is not clean. Commit or stash changes before running this script."
  exit 1
fi

echo "🔎 Type checking..."
./node_modules/.bin/tsc --noEmit

echo "📦 Building backend..."
npm run build

echo "📦 Building frontend..."
npm run build:frontend

echo "⬆️  Setting release version..."
npm version "$TARGET_VERSION" --no-git-tag-version

VERSION="$(node -p "require('./package.json').version")"
echo "📌 package.json version: $VERSION"

echo "🧪 Verifying npm package contents..."
npm pack --dry-run >/dev/null

echo "📝 Creating release commit..."
git add package.json package-lock.json README.md
git commit -m "[agent] chore: release v$VERSION"

echo "🏷️  Creating release tag..."
git tag "v$VERSION"

echo "⬆️  Pushing branch + tag..."
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$CURRENT_BRANCH"
git push origin "v$VERSION"

echo "🚀 Publishing to npm..."
npm publish --access public

echo "📋 Creating GitHub release..."
gh release create "v$VERSION" \
  --title "v$VERSION" \
  --generate-notes \
  --notes-start-tag "v$EXPECTED_CURRENT" \
  --latest

echo ""
echo "✅ cli-jaw@$VERSION released"
echo "   Install: npm install -g cli-jaw"
echo "   Release: https://github.com/lidge-ai/cli-jaw/releases/tag/v$VERSION"
