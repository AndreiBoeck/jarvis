#!/bin/bash
# Wrap the compiled JARVIS binary into JARVIS.app.
#
# Usually run through `npm run mac` from the repository root, which builds the
# interface first (into dist-mac/) and passes its folder in. By hand:
#
#   macos/build.sh [web-dir] [bridge-url]
#
# Needs the Xcode command line tools (xcode-select --install) for `swift`.
#
# Signing: ad hoc by default, which is enough to run on this Mac. macOS ties
# the Accessibility and Screen Recording permissions to the signature, and an
# ad hoc one changes with every build — so after a rebuild those two switches
# may need turning off and on again. Set JARVIS_SIGN_IDENTITY to a certificate
# in your keychain (even a self-signed "Code Signing" one made in Keychain
# Access) to keep them across builds.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WEB="${1:-$REPO/dist-mac}"
BRIDGE_URL="${2:-}"
OUT="$HERE/build"
APP="$OUT/JARVIS.app"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 1.0.0)"
[ "$VERSION" = "0.0.0" ] && VERSION="1.0.0"

if ! command -v swift >/dev/null; then
  echo "[mac] swift not found — install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi

echo "[mac] compiling the app…"
swift build --package-path "$HERE" -c release
BIN="$(swift build --package-path "$HERE" -c release --show-bin-path)/JARVIS"

echo "[mac] assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/JARVIS"

if [ -f "$WEB/index.html" ]; then
  cp -R "$WEB" "$APP/Contents/Resources/web"
else
  echo "[mac] no interface at $WEB — paired mode will have no screen (local mode is unaffected)" >&2
fi

if [ -f "$HERE/AppIcon.icns" ]; then
  cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
fi

# XML-escape the two values baked in below.
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>app.jarvis.mac</string>
  <key>CFBundleName</key><string>JARVIS</string>
  <key>CFBundleDisplayName</key><string>JARVIS</string>
  <key>CFBundleExecutable</key><string>JARVIS</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>O JARVIS ouve você pelo microfone quando você diz "Hey Jarvis".</string>
  <key>NSCameraUsageDescription</key><string>O JARVIS usa a câmera só quando você pede para ele olhar algo.</string>
  <key>NSAppleEventsUsageDescription</key><string>O JARVIS controla o Mensagens e o volume do Mac quando você pede.</string>
  <key>NSContactsUsageDescription</key><string>O JARVIS procura nos Contatos o número de quem você quer mandar mensagem.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>JarvisRepoPath</key><string>$(esc "$REPO")</string>
  <key>JarvisBridgeURL</key><string>$(esc "$BRIDGE_URL")</string>
</dict>
</plist>
PLIST

IDENTITY="${JARVIS_SIGN_IDENTITY:--}"
LABEL="$IDENTITY"; [ "$IDENTITY" = "-" ] && LABEL="ad hoc"
echo "[mac] signing ($LABEL)…"
codesign --force --deep --sign "$IDENTITY" --identifier app.jarvis.mac "$APP"

echo "[mac] built $APP"
