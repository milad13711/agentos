#!/bin/sh
# Turns a vmess:// share-link (TELEGRAM_VMESS_LINK, from .env — never
# committed, this script has no secret in it) into an Xray client config and
# runs it. Exposes a local SOCKS5 inbound (no auth) on :1080, reachable only
# from other containers on the internal `agentos` network — that's what
# backend's TELEGRAM_SOCKS_PROXY=socks5://xray:1080 talks to.
#
# Handles the vmess fields actually seen in practice: tcp or ws transport,
# tls on/off. Extend here if a future link needs grpc/kcp/h2 or per-stream
# extras this doesn't parse yet.
set -e

if [ -z "$TELEGRAM_VMESS_LINK" ]; then
  echo "[xray] TELEGRAM_VMESS_LINK not set — nothing to proxy. Sleeping instead of crash-looping."
  exec sleep infinity
fi

RAW="${TELEGRAM_VMESS_LINK#vmess://}"
# base64 -d wants correct padding; try as-is, then with padding added.
PAYLOAD=$(echo "$RAW" | base64 -d 2>/dev/null) || PAYLOAD=$(echo "${RAW}====" | cut -c1-$((${#RAW}/4*4+4)) | base64 -d 2>/dev/null) || true
if [ -z "$PAYLOAD" ]; then
  echo "[xray] could not base64-decode TELEGRAM_VMESS_LINK — check the link is a valid vmess:// share-link."
  exec sleep infinity
fi

get_field() {
  echo "$PAYLOAD" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
}

ADDR=$(get_field add)
PORT=$(get_field port)
UUID=$(get_field id)
ALTERID=$(get_field aid)
NET=$(get_field net)
TLS=$(get_field tls)
PATH_=$(get_field path)
HOST_=$(get_field host)
SNI=$(get_field sni)

STREAM_NET="${NET:-tcp}"
SECURITY="none"
[ "$TLS" = "tls" ] && SECURITY="tls"

WS_SETTINGS=""
if [ "$STREAM_NET" = "ws" ]; then
  WS_HOST="${HOST_:-$ADDR}"
  WS_SETTINGS=",\"wsSettings\":{\"path\":\"${PATH_:-/}\",\"headers\":{\"Host\":\"$WS_HOST\"}}"
fi

TLS_SETTINGS=""
if [ "$SECURITY" = "tls" ]; then
  SERVER_NAME="${SNI:-${HOST_:-$ADDR}}"
  TLS_SETTINGS=",\"tlsSettings\":{\"serverName\":\"$SERVER_NAME\",\"allowInsecure\":false}"
fi

cat > /tmp/xray-config.json <<EOF
{
  "inbounds": [{
    "port": 1080,
    "listen": "0.0.0.0",
    "protocol": "socks",
    "settings": { "auth": "noauth", "udp": true }
  }],
  "outbounds": [{
    "protocol": "vmess",
    "settings": {
      "vnext": [{
        "address": "$ADDR",
        "port": $PORT,
        "users": [{ "id": "$UUID", "alterId": ${ALTERID:-0}, "security": "auto" }]
      }]
    },
    "streamSettings": { "network": "$STREAM_NET", "security": "$SECURITY"$WS_SETTINGS$TLS_SETTINGS }
  }]
}
EOF

echo "[xray] connecting to $ADDR:$PORT (network=$STREAM_NET, security=$SECURITY), local SOCKS5 on :1080"
exec xray run -config /tmp/xray-config.json
