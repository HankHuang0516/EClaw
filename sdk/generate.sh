#!/bin/bash
# EClaw SDK Generator
# Generates Go and Rust SDKs from the OpenAPI spec
#
# Prerequisites:
#   npm install -g @openapitools/openapi-generator-cli
#   OR: brew install openapi-generator
#   OR: docker pull openapitools/openapi-generator-cli
#
# Usage:
#   ./sdk/generate.sh          # Generate both SDKs
#   ./sdk/generate.sh go       # Generate Go SDK only
#   ./sdk/generate.sh rust     # Generate Rust SDK only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SPEC_FILE="$ROOT_DIR/backend/openapi.yaml"
GO_OUTPUT="$SCRIPT_DIR/go"
RUST_OUTPUT="$SCRIPT_DIR/rust"

TARGET="${1:-all}"

if [ ! -f "$SPEC_FILE" ]; then
  echo "❌ OpenAPI spec not found at $SPEC_FILE"
  exit 1
fi

# Detect generator command
if command -v openapi-generator-cli &>/dev/null; then
  GEN_CMD="openapi-generator-cli"
elif command -v openapi-generator &>/dev/null; then
  GEN_CMD="openapi-generator"
elif npx openapi-generator-cli version &>/dev/null 2>&1; then
  GEN_CMD="npx openapi-generator-cli"
else
  echo "❌ openapi-generator-cli not found. Install with:"
  echo "   npm install -g @openapitools/openapi-generator-cli"
  echo "   OR: brew install openapi-generator"
  exit 1
fi

echo "🔧 Using generator: $GEN_CMD"
echo "📄 Spec: $SPEC_FILE"

# Generate Go SDK
if [ "$TARGET" = "all" ] || [ "$TARGET" = "go" ]; then
  echo ""
  echo "🐹 Generating Go SDK..."
  $GEN_CMD generate \
    -i "$SPEC_FILE" \
    -g go \
    -o "$GO_OUTPUT" \
    --additional-properties=packageName=eclaw \
    --additional-properties=moduleName=github.com/HankHuang0516/eclaw-sdk-go \
    --additional-properties=generateInterfaces=true \
    --additional-properties=isGoSubmodule=true
  echo "✅ Go SDK generated at $GO_OUTPUT"
fi

# Generate Rust SDK
if [ "$TARGET" = "all" ] || [ "$TARGET" = "rust" ]; then
  echo ""
  echo "🦀 Generating Rust SDK..."
  $GEN_CMD generate \
    -i "$SPEC_FILE" \
    -g rust \
    -o "$RUST_OUTPUT" \
    --additional-properties=packageName=eclaw \
    --additional-properties=packageVersion=0.1.0
  echo "✅ Rust SDK generated at $RUST_OUTPUT"
fi

echo ""
echo "🎉 SDK generation complete!"
