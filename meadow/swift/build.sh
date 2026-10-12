#!/bin/bash
# Builds Meadow.app ("Firefly Meadow") into ./build. Pass --install to copy it to /Applications and launch it.
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release
APP=build/Meadow.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/Meadow" "$APP/Contents/MacOS/Meadow"
# The NASA moon maps live once in the repo, with the web version.
cp ../html/assets/lroc_color_2k.jpg ../html/assets/ldem_3_8bit.jpg "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Meadow</string>
    <key>CFBundleDisplayName</key><string>Firefly Meadow</string>
    <key>CFBundleIdentifier</key><string>com.zeblawrence.meadow</string>
    <key>CFBundleExecutable</key><string>Meadow</string>
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
    pkill -x Meadow || true
    rm -rf /Applications/Meadow.app
    cp -R "$APP" /Applications/
    open /Applications/Meadow.app
    echo "Installed and launched /Applications/Meadow.app"
fi
