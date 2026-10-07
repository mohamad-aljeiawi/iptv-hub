#!/usr/bin/env bash
# Install IPTV Hub on a Linux server with one command, without touching any site
# or service that is already there.
#
#   sudo ./install.sh --domain iptv.example.com --email you@example.com
#
# Running this script again is safe: it duplicates nothing and loses no data.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=iptv-hub
SERVICE_USER=iptvhub
DATA_DIR=/var/lib/iptv-hub
BACKUP_DIR="$DATA_DIR/backups"
CONF_DIR=/etc/iptv-hub
ACME_ROOT=/var/www/iptv-hub-acme
PORT_MIN=18000
PORT_MAX=18999
MEMORY_MAX=1G
NODE_MIN=22.16

DOMAIN=""; EMAIL=""; WANT_PORT=""; ASSUME_YES=0; NO_SSL=0; SKIP_DNS=0

# ───────────────────────── output helpers ─────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; C=""; N=""; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s  ok%s   %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  warn%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '%s  fail%s %s\n' "$R" "$N" "$*"; }
head1(){ printf '\n%s%s%s\n' "$B" "$*" "$N"; }
die()  { bad "$*"; exit 1; }
ask()  { [ "$ASSUME_YES" = 1 ] && return 0; read -r -p "  $1 [y/N] " a </dev/tty; [[ "$a" =~ ^[yY] ]]; }

usage() {
  cat <<EOF
Usage: sudo ./install.sh --domain iptv.example.com [--email you@example.com]

  --domain <dom>   subdomain the site will be served on (required)
  --email <mail>   Let's Encrypt contact address for expiry warnings
  --port <n>       force a port instead of picking one from $PORT_MIN-$PORT_MAX
  --no-ssl         skip the certificate (HTTP only) — for testing or an external proxy
  --skip-dns       skip the DNS check (for example behind a Cloudflare proxy)
  --yes            answer yes to everything
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email)  EMAIL="${2:-}"; shift 2 ;;
    --port)   WANT_PORT="${2:-}"; shift 2 ;;
    --no-ssl) NO_SSL=1; shift ;;
    --skip-dns) SKIP_DNS=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root:  sudo ./install.sh ..."
[ -n "$DOMAIN" ] || { usage; die "--domain is required"; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "invalid domain: $DOMAIN"

# ═════════════════════════════════════════════════════════════════
#  1) pre-flight checks — full report before anything is changed
# ═════════════════════════════════════════════════════════════════
head1 "1) Checking the server before making any change"

# ── operating system ──
. /etc/os-release 2>/dev/null || die "could not read /etc/os-release"
OS_OK=0
case "${ID}-${VERSION_ID}" in
  ubuntu-22.04|ubuntu-24.04|debian-12) OS_OK=1 ;;
esac
if [ "$OS_OK" = 1 ]; then ok "OS: $PRETTY_NAME"
else warn "OS: $PRETTY_NAME (officially supported: Ubuntu 22.04/24.04, Debian 12)"; fi

for c in curl ss systemctl; do command -v "$c" >/dev/null || MISSING="${MISSING:-} $c"; done
[ -z "${MISSING:-}" ] || warn "missing tools, will be installed:${MISSING}"

# ── Node.js ──
NODE_BIN="$(command -v node || true)"
NODE_VER="$([ -n "$NODE_BIN" ] && node -v 2>/dev/null | tr -d v || echo '')"
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
NODE_OK=0
if [ -n "$NODE_VER" ] && ver_ge "$NODE_VER" "$NODE_MIN"; then NODE_OK=1; ok "Node.js: v$NODE_VER"
elif [ -n "$NODE_VER" ]; then warn "Node.js: v$NODE_VER is older than the required v$NODE_MIN"
else warn "Node.js: not installed (v$NODE_MIN or newer required)"; fi

# ── existing web server on 80/443 ──
WEB_PROC="$(ss -ltnp 2>/dev/null | awk '$4 ~ /[:.](80|443)$/' | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' ')"
WEB=""
case " $WEB_PROC " in
  *" nginx "*)   WEB=nginx ;;
  *" caddy "*)   WEB=caddy ;;
  *" apache2 "*|*" httpd "*) WEB=apache ;;
  *" traefik "*) WEB=traefik ;;
esac
if [ -n "$WEB" ]; then ok "web server present: $WEB (nothing belonging to your other sites will be touched)"
elif [ -n "$WEB_PROC" ]; then warn "port 80/443 is busy:$WEB_PROC"
else ok "no web server on 80/443 — Caddy will be installed (automatic certificates)"; WEB=none; fi

# ── DNS ──
SERVER_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
DNS_IPS="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
DNS_OK=0
if [ "$SKIP_DNS" = 1 ]; then DNS_OK=1; warn "DNS check skipped (--skip-dns)"
elif [ -z "$DNS_IPS" ]; then bad "$DOMAIN does not resolve to any address"
elif [[ " $DNS_IPS " == *" $SERVER_IP "* ]]; then DNS_OK=1; ok "DNS: $DOMAIN -> $SERVER_IP"
else bad "$DOMAIN resolves to $DNS_IPS but this server is $SERVER_IP"; fi

if [ "$DNS_OK" = 0 ]; then
  cat <<EOF

${B}Add this record at your DNS provider, then run the script again:${N}

    ${C}Type:   A
    Name:   ${DOMAIN%%.*}
    Value:  $SERVER_IP
    TTL:    Auto${N}

  (behind a Cloudflare proxy? run with --skip-dns)
EOF
  exit 1
fi

# ── pick a free port ─────────────────────────────────────────────
port_free() {
  local p="$1"
  # currently listening?
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then return 1; fi
  # reserved in an nginx config, another systemd unit, or a Caddy file?
  if grep -rlE "(:|\b)$p\b" /etc/nginx 2>/dev/null | grep -q .; then return 1; fi
  if grep -rlE "(:|\b)$p\b" /etc/systemd/system /etc/caddy 2>/dev/null | grep -qv "$SERVICE"; then return 1; fi
  return 0
}
# A port chosen earlier stays put, so it never changes across restarts or updates.
OLD_PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/.env" 2>/dev/null | head -1 || true)"
if [ -n "$WANT_PORT" ]; then PORT="$WANT_PORT"
elif [ -n "$OLD_PORT" ]; then PORT="$OLD_PORT"
else
  PORT=""
  for p in $(seq "$PORT_MIN" "$PORT_MAX"); do if port_free "$p"; then PORT="$p"; break; fi; done
  [ -n "$PORT" ] || die "no free port between $PORT_MIN and $PORT_MAX"
fi
ok "port: $PORT (bound to 127.0.0.1 only, no firewall port needs opening)"

# ── plan ──
head1 "Plan"
say "  code:        $APP_DIR"
say "  data:        $DATA_DIR   (separate from the code, untouched by updates)"
say "  user:        $SERVICE_USER (no privileges, no login shell)"
say "  service:     systemd/$SERVICE.service"
say "  site:        https://$DOMAIN -> 127.0.0.1:$PORT"
say "  web server:  $WEB"
[ "$NO_SSL" = 1 ] && say "  certificate: disabled (--no-ssl)" || true
echo
ask "Proceed with the installation?" || { say "Cancelled."; exit 0; }

# ═════════════════════════════════════════════════════════════════
#  2) dependencies
# ═════════════════════════════════════════════════════════════════
head1 "2) Dependencies"
export DEBIAN_FRONTEND=noninteractive
apt_installed() { dpkg -s "$1" >/dev/null 2>&1; }
need_pkgs=""
for p in curl ca-certificates gnupg; do apt_installed "$p" || need_pkgs="$need_pkgs $p"; done
if [ -n "$need_pkgs" ]; then apt-get update -qq && apt-get install -y -qq $need_pkgs; ok "base tools:$need_pkgs"; fi

if [ "$NODE_OK" = 0 ]; then
  if ask "Install Node.js 22 from the official NodeSource repository?"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs
    ok "Node.js $(node -v)"
  else
    die "this project needs Node.js $NODE_MIN or newer"
  fi
fi
NODE_BIN="$(command -v node)"

# ═════════════════════════════════════════════════════════════════
#  3) user and data directory
# ═════════════════════════════════════════════════════════════════
head1 "3) User and data"
if id "$SERVICE_USER" >/dev/null 2>&1; then ok "user $SERVICE_USER already exists"
else
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "created user $SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$DATA_DIR" "$BACKUP_DIR"
install -d -m 755 "$CONF_DIR"
ok "data directory: $DATA_DIR"

# ── .env (the port is stored here, so it never changes again) ──
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  sed -i "s|^PORT=.*|PORT=$PORT|; s|^DB=.*|DB=$DATA_DIR/catalog.db|; s|^HOST=.*|HOST=127.0.0.1|" "$ENV_FILE"
  grep -q '^PUBLIC_URL=' "$ENV_FILE" || printf 'PUBLIC_URL=\n' >> "$ENV_FILE"
  ok "updated the existing .env (admin password and data are untouched)"
else
  umask 027
  cat > "$ENV_FILE" <<EOF
# Generated by install.sh — never committed to git
PORT=$PORT
HOST=127.0.0.1
DB=$DATA_DIR/catalog.db
ADMIN_TOKEN=
PUBLIC_URL=
SYNC_HOURS=6
HEALTH_MIN=5
UA=Mozilla/5.0
EOF
  ok "created .env"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
chown -R root:"$SERVICE_USER" "$APP_DIR/src" "$APP_DIR/public" 2>/dev/null || true

# ═════════════════════════════════════════════════════════════════
#  4) systemd service
# ═════════════════════════════════════════════════════════════════
head1 "4) Service"
T="$APP_DIR/scripts/templates"
render() { sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__DATA_DIR__|$DATA_DIR|g" -e "s|__USER__|$SERVICE_USER|g" \
               -e "s|__NODE__|$NODE_BIN|g" -e "s|__MEMORY_MAX__|$MEMORY_MAX|g" -e "s|__DOMAIN__|$DOMAIN|g" \
               -e "s|__PORT__|$PORT|g" -e "s|__ACME_ROOT__|$ACME_ROOT|g" "$1"; }

render "$T/iptv-hub.service" > "/etc/systemd/system/$SERVICE.service"

cat > "/etc/systemd/system/$SERVICE-backup.service" <<EOF
[Unit]
Description=IPTV Hub — daily database backup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/iptvhub backup --quiet
EOF
cat > "/etc/systemd/system/$SERVICE-backup.timer" <<EOF
[Unit]
Description=IPTV Hub — daily database backup
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30m
[Install]
WantedBy=timers.target
EOF

install -m 755 "$APP_DIR/scripts/iptvhub" /usr/local/bin/iptvhub
cat > "$CONF_DIR/config" <<EOF
APP_DIR=$APP_DIR
DATA_DIR=$DATA_DIR
BACKUP_DIR=$BACKUP_DIR
SERVICE=$SERVICE
SERVICE_USER=$SERVICE_USER
DOMAIN=$DOMAIN
PORT=$PORT
WEB=$WEB
NODE_BIN=$NODE_BIN
ACME_ROOT=$ACME_ROOT
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE.service" >/dev/null 2>&1
systemctl enable --now "$SERVICE-backup.timer" >/dev/null 2>&1
systemctl restart "$SERVICE.service"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then ok "service running, and it will come back after a reboot"
else journalctl -u "$SERVICE" -n 20 --no-pager; die "the service failed to start"; fi

# ═════════════════════════════════════════════════════════════════
#  5) domain and certificate
# ═════════════════════════════════════════════════════════════════
head1 "5) Domain and certificate"
install -d -m 755 "$ACME_ROOT"

# Writes the site file, dropping IPv6 lines on hosts without IPv6 (otherwise the
# bind fails on reload).
render_site() { render "$1" > "$2"; if [ ! -f /proc/net/if_inet6 ]; then sed -i '/\[::\]/d' "$2"; fi; }

setup_nginx() {
  local avail=/etc/nginx/sites-available/iptv-hub.conf
  local link=/etc/nginx/sites-enabled/iptv-hub.conf
  local had_file=0
  if [ -f "$avail" ]; then had_file=1; cp "$avail" "$avail.prev"; fi

  render "$T/nginx-proxy.conf" > /etc/nginx/iptv-hub-proxy.conf
  install -d -m 755 /etc/nginx/conf.d
  render "$T/nginx-limits.conf" > /etc/nginx/conf.d/iptv-hub-limits.conf

  # If the certificate already exists (re-run), go straight to the SSL config.
  local tpl="$T/nginx-http.conf"
  if [ "$NO_SSL" = 0 ] && [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then tpl="$T/nginx-ssl.conf"; fi
  render_site "$tpl" "$avail"
  [ -L "$link" ] || ln -sf "$avail" "$link"

  if ! nginx -t >/tmp/iptvhub-nginx.log 2>&1; then
    cat /tmp/iptvhub-nginx.log
    rm -f "$avail" "$link" /etc/nginx/conf.d/iptv-hub-limits.conf /etc/nginx/iptv-hub-proxy.conf
    if [ "$had_file" = 1 ]; then mv "$avail.prev" "$avail"; fi
    die "nginx config test failed — our files were removed and the server is exactly as it was"
  fi
  rm -f "$avail.prev"
  systemctl reload nginx
  ok "added a standalone file: $avail (no existing file was modified)"

  if [ "$NO_SSL" = 0 ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    apt_installed certbot || { apt-get install -y -qq certbot; }
    # deploy-hook so nginx is reloaded automatically on every renewal
    local args=(certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --non-interactive --agree-tos --no-eff-email
                --deploy-hook "systemctl reload nginx")
    [ -n "$EMAIL" ] && args+=(-m "$EMAIL") || args+=(--register-unsafely-without-email)
    if certbot "${args[@]}"; then
      render_site "$T/nginx-ssl.conf" "$avail"
      if nginx -t >/dev/null 2>&1; then systemctl reload nginx; ok "certificate issued for $DOMAIN only"
      else render_site "$T/nginx-http.conf" "$avail"; systemctl reload nginx; warn "could not enable SSL, the site stays on HTTP"; fi
    else
      warn "certificate issuance failed. The site works over HTTP; retry with: certbot certonly --webroot -w $ACME_ROOT -d $DOMAIN"
    fi
  fi
}

setup_caddy() {
  if ! command -v caddy >/dev/null; then
    ask "Install Caddy (issues and renews certificates automatically)?" || die "no web server available"
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy
    ok "Caddy installed"
  fi
  install -d -m 755 /etc/caddy/conf.d
  render "$T/iptv-hub.caddy" > /etc/caddy/conf.d/iptv-hub.caddy
  if ! grep -q 'conf.d' /etc/caddy/Caddyfile 2>/dev/null; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)" 2>/dev/null || true
    printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
  fi
  if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy || systemctl restart caddy
    ok "added a standalone site: /etc/caddy/conf.d/iptv-hub.caddy (automatic certificate)"
  else
    rm -f /etc/caddy/conf.d/iptv-hub.caddy
    die "Caddy config validation failed — our file was removed and the server is as it was"
  fi
}

print_manual() {
  warn "the existing server ($WEB) will not be touched. Add this configuration yourself:"
  echo
  if [ "$WEB" = apache ]; then
    cat <<EOF
${C}<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "http"
    # player paths stay on HTTP with no redirect
    ProxyPass        /player_api.php http://127.0.0.1:$PORT/player_api.php
    ProxyPassReverse /player_api.php http://127.0.0.1:$PORT/player_api.php
    ProxyPass        /get.php  http://127.0.0.1:$PORT/get.php
    ProxyPass        /xmltv.php http://127.0.0.1:$PORT/xmltv.php
    ProxyPass        /live/   http://127.0.0.1:$PORT/live/
    ProxyPass        /movie/  http://127.0.0.1:$PORT/movie/
    ProxyPass        /series/ http://127.0.0.1:$PORT/series/
    ProxyPass        /watch/  http://127.0.0.1:$PORT/watch/
    ProxyPass        /w/      http://127.0.0.1:$PORT/w/
    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/(player_api\.php|get\.php|xmltv\.php|live/|movie/|series/|watch/|w/)
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName $DOMAIN
    SSLEngine on
    # point these at your certificate
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass        / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
</VirtualHost>${N}

  then: a2enmod proxy proxy_http headers rewrite ssl && systemctl reload apache2
EOF
  else
    cat <<EOF
${C}# container labels, or a dynamic file for Traefik:
http:
  routers:
    iptv-hub:
      rule: "Host(\`$DOMAIN\`)"
      entryPoints: [websecure]
      service: iptv-hub
      tls: { certResolver: le }
    iptv-hub-http:
      rule: "Host(\`$DOMAIN\`) && (PathPrefix(\`/live/\`) || PathPrefix(\`/movie/\`) || PathPrefix(\`/series/\`) || PathPrefix(\`/watch/\`) || PathPrefix(\`/w/\`) || Path(\`/player_api.php\`) || Path(\`/get.php\`) || Path(\`/xmltv.php\`))"
      entryPoints: [web]
      service: iptv-hub          # deliberately no https redirect middleware
  services:
    iptv-hub:
      loadBalancer:
        servers: [{ url: "http://127.0.0.1:$PORT" }]${N}
EOF
  fi
  echo
}

case "$WEB" in
  nginx) setup_nginx ;;
  none|caddy) setup_caddy ;;
  *) print_manual ;;
esac

# ═════════════════════════════════════════════════════════════════
head1 "Done"
ADMIN_PASS="$(/usr/local/bin/iptvhub admin-pass --quiet 2>/dev/null || echo '?')"
PROTO=https
if [ "$NO_SSL" = 1 ]; then PROTO=http
elif [ "$WEB" = nginx ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then PROTO=http
fi
cat <<EOF

  Site:        ${C}$PROTO://$DOMAIN${N}
  Username:    ${C}admin${N}
  Password:    ${C}$ADMIN_PASS${N}

  Player URL (TiviMate / Smarters) — type Xtream Codes:
      ${C}http://$DOMAIN${N}   or   ${C}https://$DOMAIN${N}

  Management:
      ${C}iptvhub status | logs | restart | update | backup | admin-pass | uninstall${N}

EOF
