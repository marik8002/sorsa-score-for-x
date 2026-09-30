#!/bin/sh
set -eu

ROOT_DIR=${PACKAGE_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
ARCHIVE_PATH="$ROOT_DIR/dist/sorsa-score-extension.zip"
INSTALL_FILES='manifest.json
core.js
content-script.js
service-worker.js
site-bridge.js
popup.html
popup.js
popup.css
images/sorsa-logo.svg
icons/icon-16.png
icons/icon-32.png
icons/icon-48.png
icons/icon-128.png
README.txt'

fail() {
  printf '%s\n' "package verification failed: $*" >&2
  exit 1
}

cd "$ROOT_DIR"

for file in $INSTALL_FILES; do
  [ -f "$file" ] || fail "missing install file: $file"
done

jq -e '
  .manifest_version == 3 and
  .permissions == ["storage"] and
  ((has("optional_permissions") | not) or .optional_permissions == []) and
  .host_permissions == ["https://app.sorsa.io/*"] and
  .icons == {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  } and
  .action.default_icon == .icons and
  .background.service_worker == "service-worker.js" and
  .content_scripts == [{
    "matches": ["https://x.com/*", "https://twitter.com/*"],
    "js": ["core.js", "content-script.js"],
    "run_at": "document_idle"
  }, {
    "matches": ["https://app.sorsa.io/*"],
    "js": ["site-bridge.js"],
    "run_at": "document_idle"
  }]
' manifest.json >/dev/null || fail 'manifest is invalid or requests prohibited permissions'

for script in core.js content-script.js service-worker.js site-bridge.js popup.js; do
  node --check "$script" >/dev/null || fail "invalid JavaScript: $script"
done

for file in $INSTALL_FILES; do
  case "$file" in
    *capture-token*|*capture-bridge*|*config.json*) fail "forbidden install filename: $file" ;;
  esac
done

if grep -EIn \
  -e 'Bearer[[:space:]]+[A-Za-z0-9._~+/-]{8,}' \
  -e "(api[_-]?key|guest[_-]?token|access[_-]?token)[[:space:]]*[:=][[:space:]]*[\\\"']?[^\\\"']{8,}" \
  -e '(sk|pk|ghp|xox[bps])_[A-Za-z0-9_-]{8,}' \
  -e 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}' \
  -e 'webRequest|onBeforeSendHeaders|onHeadersReceived|XMLHttpRequest\.prototype\.open' \
  $INSTALL_FILES >/dev/null; then
  fail 'credential-shaped or traffic-capture content found'
fi

if grep -EIn 'config\.json|readFile(Sync)?\([^)]*config|require\([^)]*config' \
  core.js content-script.js service-worker.js site-bridge.js popup.js >/dev/null; then
  fail 'configuration read found'
fi

[ -s "$ARCHIVE_PATH" ] || fail 'distribution ZIP is missing or empty'

actual_entries=$(unzip -Z1 "$ARCHIVE_PATH" | LC_ALL=C sort)
expected_entries=$(printf '%s\n' "$INSTALL_FILES" | LC_ALL=C sort)
[ "$actual_entries" = "$expected_entries" ] || fail 'ZIP contains missing or unexpected entries'

for file in $INSTALL_FILES; do
  unzip -p "$ARCHIVE_PATH" "$file" > ".verify-package.$$"
  cmp -s ".verify-package.$$" "$file" || {
    rm -f ".verify-package.$$"
    fail "ZIP entry differs from source: $file"
  }
done
rm -f ".verify-package.$$"

printf '%s\n' 'package verification passed'
