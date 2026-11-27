#!/bin/sh
# Builds ~/Applications/Herdr Notifications.app: a copy of terminal-notifier with Herdr's name and
# icon, so Herdr's notifications in Notification Center look like Herdr's. toast-md uses it when
# it exists (see README, "Notifications in Notification Center").
#
#   sh tools/herdr-notifications.sh
#
# Needs terminal-notifier (brew install terminal-notifier) and Herdr in /Applications.
# Afterwards allow "Herdr" in System Settings > Notifications (macOS asks, or lists it there).
set -eu

src="$(brew --prefix terminal-notifier 2>/dev/null)/terminal-notifier.app"
herdr=/Applications/Herdr.app
app="$HOME/Applications/Herdr Notifications.app"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ -d "$src" ] || { echo "terminal-notifier not found: brew install terminal-notifier" >&2; exit 1; }
[ -f "$herdr/Contents/Resources/Herdr.icns" ] || { echo "Herdr.app not found in /Applications" >&2; exit 1; }

mkdir -p "$HOME/Applications"
rm -rf "$app"
cp -R "$src" "$app"
cp "$herdr/Contents/Resources/Herdr.icns" "$app/Contents/Resources/Herdr.icns"
rm -f "$app/Contents/Resources/Terminal.icns"
plist="$app/Contents/Info.plist"
plutil -replace CFBundleIconFile -string Herdr "$plist"
plutil -replace CFBundleIdentifier -string local.herdr.notifications "$plist"
plutil -replace CFBundleName -string Herdr "$plist"
plutil -replace CFBundleDisplayName -string Herdr "$plist" 2>/dev/null || plutil -insert CFBundleDisplayName -string Herdr "$plist"
# Editing the bundle breaks its signature: sign it again, locally (ad hoc).
codesign --force --deep -s - "$app"
# Register it as an app and start it once, so macOS can ask for notification permission.
"$lsregister" -f "$app"
open "$app" --args -title Herdr -message "Allow notifications for Herdr in System Settings if asked"
echo "Built $app. Allow \"Herdr\" in System Settings > Notifications."
