#!/usr/bin/env bash
# REA Phone Starter: one-step setup.
#
# Gets REA (Reverse Engineer Anything) ready inside a Claude Code cloud
# session, together with the two Android tools REA needs but does not
# install itself:
#   - jadx-headless-mcp: turns an Android app's code back into readable Java
#   - Apktool: unpacks an app's settings file, text and translations
#
# Every download is checked against a known fingerprint (SHA-256) and is
# deleted if it doesn't match. Safe to run again: anything already in
# place is skipped.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/tools"
ENV_FILE="$ROOT/.rea-env"

REA_VERSION="6.9.0"

JADX_VERSION="0.7.1"
JADX_JAR="jadx-headless-mcp-${JADX_VERSION}-all.jar"
JADX_URL="https://github.com/1013503897/jadx-headless-mcp/releases/download/v${JADX_VERSION}/${JADX_JAR}"
JADX_SHA256="6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75"

APKTOOL_VERSION="3.0.3"
APKTOOL_JAR="apktool_${APKTOOL_VERSION}.jar"
APKTOOL_URL="https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/${APKTOOL_JAR}"
APKTOOL_SHA256="dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423"

ok()   { printf '  ✅ %s\n' "$1"; }
info() { printf '  ⏳ %s\n' "$1"; }
warn() { printf '  ⚠️  %s\n' "$1"; }
fail() { printf '  ❌ %s\n' "$1" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# fetch URL DEST EXPECTED_SHA256
fetch() {
  local url="$1" dest="$2" want="$3" name got
  name="$(basename "$dest")"
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$want" ]; then
    ok "$name is already here"
    return 0
  fi
  info "Downloading $name..."
  if ! curl -fsSL --retry 2 -o "$dest.part" "$url"; then
    rm -f "$dest.part"
    fail "Couldn't download $name from $url. If this session blocks downloads from github.com, its network setting may need to allow GitHub."
  fi
  got="$(sha256_of "$dest.part")"
  if [ "$got" != "$want" ]; then
    rm -f "$dest.part"
    fail "$name didn't match its expected fingerprint, so it was deleted for safety. (expected $want, got $got)"
  fi
  mv "$dest.part" "$dest"
  ok "$name downloaded and verified"
}

echo ""
echo "🔧 REA Phone Starter setup"
echo ""

# 1. Node.js: REA itself runs on Node.
command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1 \
  || fail "Node.js isn't installed. REA needs Node.js 22.23.4+, 24.22.1+ or 26.12.1+."
if node -e '
  const [a, b, c] = process.versions.node.split(".").map(Number);
  const atLeast = (x, y, z) => a > x || (a === x && (b > y || (b === y && c >= z)));
  const fits = (a === 22 && atLeast(22, 23, 4)) || (a === 24 && atLeast(24, 22, 1)) || atLeast(26, 12, 1);
  process.exit(fits ? 0 : 1);
'; then
  ok "Node.js $(node --version)"
else
  warn "Node.js $(node --version) is older than REA officially supports (22.23.4+, 24.22.1+ or 26.12.1+). Trying anyway."
fi

# 2. Java: both Android tools are Java programs, and REA asks for a full JDK.
if ! command -v java >/dev/null 2>&1 || ! command -v javac >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
    info "Installing Java (OpenJDK 21)..."
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq openjdk-21-jdk-headless >/dev/null 2>&1 \
      || fail "Couldn't install Java automatically. REA's Android tools need a Java JDK (version 17 or newer)."
  else
    fail "Java isn't installed. REA's Android tools need a Java JDK (version 17 or newer)."
  fi
fi
ok "Java $(java -version 2>&1 | sed -n 's/.*version "\([^"]*\)".*/\1/p' | head -1)"

# 3. The two Android tools, checked against their fingerprints.
mkdir -p "$TOOLS"
fetch "$JADX_URL" "$TOOLS/$JADX_JAR" "$JADX_SHA256"
fetch "$APKTOOL_URL" "$TOOLS/$APKTOOL_JAR" "$APKTOOL_SHA256"

# REA wants an Apktool "launcher" it can run directly.
cat > "$TOOLS/apktool" <<EOF
#!/bin/sh
exec java -jar "$TOOLS/$APKTOOL_JAR" "\$@"
EOF
chmod +x "$TOOLS/apktool"
"$TOOLS/apktool" --version >/dev/null 2>&1 || fail "Apktool downloaded but won't start."
ok "Apktool $APKTOOL_VERSION ready"

# 4. REA itself (downloaded once, then reused from the npm cache).
info "Getting REA $REA_VERSION ready (the first time can take a minute)..."
npx -y "rea-agents@$REA_VERSION" --help >/dev/null 2>&1 \
  || fail "Couldn't start REA. Check that this session can reach the npm registry."
ok "REA $REA_VERSION ready"

# 5. Save the settings REA reads, so scripts/rea can load them.
cat > "$ENV_FILE" <<EOF
# Written by scripts/setup.sh. Loaded by scripts/rea.
export REA_VERSION="$REA_VERSION"
export REA_JADX_MCP_JAR="$TOOLS/$JADX_JAR"
export REA_APKTOOL_COMMAND="$TOOLS/apktool"
EOF
mkdir -p "$ROOT/apps" "$ROOT/reports"
ok "Settings saved"

echo ""
echo "🎉 All set! Try asking Claude:"
echo "   \"Get Fossify Calculator from F-Droid and tell me about it.\""
echo ""
