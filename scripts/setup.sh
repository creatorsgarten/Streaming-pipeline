#!/usr/bin/env bash
# Creates .env with random secrets (once) and prints the admin password.
#   ./scripts/setup.sh                       local use: http://localhost:8790, RTMP on 1936
#   ./scripts/setup.sh stream.example.com    a server: HTTPS via Caddy on that domain, RTMP on 1935, SRT on 8890/udp
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then echo ".env already exists — leaving it alone"; exit 0; fi
rand() { head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c "$1" || true; }
domain="${1:-}"
pw=$(rand 20)
{
  echo "HUB_SECRET=$(rand 48)"
  echo "ADMIN_PASSWORD=$pw"
  echo "INTERNAL_TOKEN=$(rand 32)"
  if [ -n "$domain" ]; then
    echo "COMPOSE_PROFILES=https"
    echo "DOMAIN=$domain"
    echo "TRUST_PROXY=1"
    echo "RTMP_PORT=1935"
    echo "SRT_PORT=8890"
    echo "PUBLIC_RTMP=rtmp://$domain:1935"
    echo "PUBLIC_SRT=srt://$domain:8890"
  else
    echo "SECURE_COOKIES=0"
  fi
} > .env
chmod 600 .env
echo "Wrote .env — admin password: $pw"
if [ -n "$domain" ]; then
  echo "Next: point $domain's DNS (A record) at this server, open ports 80, 443, 1935/tcp, 8890/udp, then: docker compose up -d --build"
  echo "Dashboard: https://$domain"
fi
