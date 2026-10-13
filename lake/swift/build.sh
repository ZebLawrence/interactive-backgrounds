#!/bin/bash
# Builds Lake.app ("Loon Lake") into ./build. Pass --install to copy it to /Applications and launch it.
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release
APP=build/Lake.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/Lake" "$APP/Contents/MacOS/Lake"
# The NASA moon maps live once in the repo, with Firefly Meadow's web version.
cp ../../meadow/html/assets/lroc_color_2k.jpg ../../meadow/html/assets/ldem_3_8bit.jpg "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Lake</string>
    <key>CFBundleDisplayName</key><string>Loon Lake</string>
    <key>CFBundleIdentifier</key><string>com.zeblawrence.lake</string>
    <key>CFBundleExecutable</key><string>Lake</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP"
echo "Built $APP"

if [[ "${1:-}" == "--install" ]]; then
    pkill -x Lake || true
    rm -rf /Applications/Lake.app
    cp -R "$APP" /Applications/
    open /Applications/Lake.app
    echo "Installed and launched /Applications/Lake.app"
fi
