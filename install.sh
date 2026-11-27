#!/bin/sh
# Installs the macOS theme for the Herdr app into Herdr's config folder.
#
#   sh install.sh            copy files; stop if any would overwrite a different file
#   sh install.sh --force    overwrite differing files and key bindings
#   sh install.sh --switch   also switch the window to the "macos" layout afterwards
#
# Target: $HERDR_APP_HOME, else ~/.config/herdr-app (Herdr's default on macOS and Linux).
# Herdr reloads changed files by itself; no restart needed.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
force=0
switch=0
for arg in "$@"; do
  case $arg in
    --force) force=1 ;;
    --switch) switch=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

[ -d "$home" ] || { echo "Herdr config folder not found: $home (start Herdr once first)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "needs python3" >&2; exit 1; }

# 1. Preflight: list files that exist with different content.
conflicts=$(cd "$here" && find themes layouts mods -type f ! -name '.DS_Store' | while IFS= read -r f; do
  if [ -e "$home/$f" ] && ! cmp -s "$f" "$home/$f"; then echo "$f"; fi
done)
if [ -n "$conflicts" ] && [ "$force" -eq 0 ]; then
  echo "These files already exist in $home with different content:" >&2
  echo "$conflicts" | sed 's/^/  /' >&2
  echo "Nothing was copied. Re-run with --force to overwrite them." >&2
  exit 1
fi

# 2. Copy themes, layouts and mods.
(cd "$here" && find themes layouts mods -type f ! -name '.DS_Store') | while IFS= read -r f; do
  mkdir -p "$home/$(dirname "$f")"
  cp "$here/$f" "$home/$f"
done
echo "Copied themes, layouts and mods into $home"

# 3. Merge key bindings into keys.json (keeps everything else).
python3 -I - "$here/keys.json" "$home/keys.json" "$force" <<'PY'
import json, os, sys
snippet_path, keys_path, force = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
snippet = json.load(open(snippet_path))
# Herdr's own defaults for keys the theme rebinds: these are replaced, not kept as the user's.
herdr_defaults = {"cmd-b": "layout.toggle:sidebar"}
keys = json.load(open(keys_path)) if os.path.exists(keys_path) else {}
for section, bindings in snippet.items():
    current = keys.setdefault(section, {})
    for key, action in bindings.items():
        customised = key in current and current[key] != action and current[key] != herdr_defaults.get(key)
        if customised and not force:
            print(f"  kept your {key}: {current[key]!r} (theme wants {action!r}; --force to replace)")
            continue
        current[key] = action
json.dump(keys, open(keys_path, "w"), indent=2, ensure_ascii=False)
open(keys_path, "a").write("\n")
print(f"Merged key bindings into {keys_path}")
PY

# 4. Check each mod loads.
if command -v herdr-app >/dev/null; then
  for m in "$here"/mods/*/; do
    name=$(basename "$m")
    herdr-app check "$home/mods/$name" 2>&1 | grep -v '^ *WARN' | tail -1
  done
  if [ "$switch" -eq 1 ]; then
    herdr-app do layout.switch '{"name":"macos"}' >/dev/null && echo "Switched to the macos layout"
  else
    echo "Pick the layout in Herdr: Cmd+Shift+L, or Settings (macOS)."
  fi
else
  echo "herdr-app not on PATH: skipped checks. Pick the layout in Herdr's Settings."
fi
