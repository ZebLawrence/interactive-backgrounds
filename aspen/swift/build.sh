#!/bin/bash
# Builds Aspen.app ("Aspen Snow") into ./build. Pass --install to copy it to /Applications and launch it.
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release
APP=build/Aspen.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/Aspen" "$APP/Contents/MacOS/Aspen"
# The NASA moon maps, shared with the web version.
cp ../html/assets/lroc_color_2k.jpg ../html/assets/ldem_3_8bit.jpg "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Aspen</string>
    <key>CFBundleDisplayName</key><string>Aspen Snow</string>
    <key>CFBundleIdentifier</key><string>com.zeblawrence.aspen</string>
    <key>CFBundleExecutable</key><string>Aspen</string>
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
    pkill -x Aspen || true
    rm -rf /Applications/Aspen.app
    cp -R "$APP" /Applications/
    open /Applications/Aspen.app
    echo "Installed and launched /Applications/Aspen.app"
fi
