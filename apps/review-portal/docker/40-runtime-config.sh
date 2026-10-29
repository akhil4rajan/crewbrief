#!/bin/sh
# Writes /config.js and the CSP header from the environment, so one image serves every environment.
# Uses the same variable names as the Vite build (VITE_*).
set -eu

OUT=/usr/share/nginx/runtime
API="${VITE_API_BASE_URL:-http://localhost:8001}"
GATEWAY="${VITE_GATEWAY_URL:-http://localhost:8000}"
AUTH_MODE="${VITE_AUTH_MODE:-dev}"
ENTRA_CLIENT_ID="${VITE_ENTRA_CLIENT_ID:-}"
ENTRA_AUTHORITY="${VITE_ENTRA_AUTHORITY:-https://login.microsoftonline.com/common}"
ENTRA_SCOPES="${VITE_ENTRA_SCOPES:-}"
# Extra connect-src origins, e.g. the Web PubSub endpoint used in azure mode.
CONNECT_EXTRA="${CSP_CONNECT_EXTRA:-wss://*.webpubsub.azure.com}"

# JSON string escape (backslash, quote) plus "<" so the value cannot close a script context.
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/</\\u003c/g'; }
origin() { printf '%s' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://[^/]+).*#\1#'; }

scopes_json=""
for s in $(printf '%s' "$ENTRA_SCOPES" | tr ',' ' '); do
  scopes_json="${scopes_json:+$scopes_json, }\"$(esc "$s")\""
done

cat > "$OUT/config.js" <<JS
window.__CREWBRIEF_CONFIG__ = {
  "apiBaseUrl": "$(esc "$API")",
  "gatewayUrl": "$(esc "$GATEWAY")",
  "authMode": "$(esc "$AUTH_MODE")",
  "entraClientId": "$(esc "$ENTRA_CLIENT_ID")",
  "entraAuthority": "$(esc "$ENTRA_AUTHORITY")",
  "entraScopes": [$scopes_json]
};
JS

api_o="$(origin "$API")"
gw_o="$(origin "$GATEWAY")"
gw_ws="$(printf '%s' "$gw_o" | sed -E 's#^http#ws#')"
auth_o="$(origin "$ENTRA_AUTHORITY")"
connect="'self' $api_o $gw_o $gw_ws $auth_o $CONNECT_EXTRA"
# Strip characters that could break out of the nginx directive.
connect="$(printf '%s' "$connect" | tr -d '";\n')"

printf 'add_header Content-Security-Policy "default-src '"'"'self'"'"'; script-src '"'"'self'"'"'; style-src '"'"'self'"'"' '"'"'unsafe-inline'"'"'; img-src '"'"'self'"'"' data:; media-src '"'"'self'"'"' data: blob:; font-src '"'"'self'"'"'; connect-src %s; frame-src %s; frame-ancestors '"'"'none'"'"'; base-uri '"'"'self'"'"'; form-action '"'"'self'"'"'; object-src '"'"'none'"'"'" always;\n' \
  "$connect" "$auth_o" > "$OUT/csp.conf"

echo "review-portal: runtime config written (api=$API gateway=$GATEWAY auth=$AUTH_MODE)"
