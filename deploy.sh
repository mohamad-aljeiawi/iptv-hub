#!/usr/bin/env bash
# Deploy or update IPTV Hub with Docker Compose behind nginx, with a Let's Encrypt
# certificate. The same command does the first deployment and every update, and
# running it again changes nothing that is already right.
#
# First deployment on a server:
#   curl -fsSL https://raw.githubusercontent.com/mohamad-aljeiawi/iptv-hub/main/deploy.sh -o deploy.sh
#   sudo bash deploy.sh
# Every update after that:
#   sudo bash /opt/iptv-hub/deploy.sh
# Back up the database now (the daily timer runs this too):
#   sudo bash /opt/iptv-hub/deploy.sh --backup
#
# It asks for two things only: the domain and the email for Let's Encrypt. Both
# are remembered and offered as defaults on the next run.
#
# Requires Docker with the Compose plugin. nginx, certbot and git are installed
# with apt when missing.
set -euo pipefail

REPO_URL=https://github.com/mohamad-aljeiawi/iptv-hub.git
BRANCH=main
APP_DIR=/opt/iptv-hub
CONF_DIR=/etc/iptv-hub
CONF="$CONF_DIR/deploy.conf"
BACKUP_DIR=/var/backups/iptv-hub
ACME_ROOT=/var/www/iptv-hub-acme
IMPORT_DB=/root/iptv-hub-import.db   # copied into a fresh install once, if present
LOCK=/run/iptv-hub-deploy.lock
CONTAINER=iptv-hub
CONTAINER_UID=1000                   # the "node" user in the official image
PORT_MIN=18000
PORT_MAX=18999
KEEP=7

# ───────────────────────── output helpers ─────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; C=""; N=""; fi
ok()   { printf '%s  ok%s   %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  warn%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '%s  fail%s %s\n' "$R" "$N" "$*" >&2; }
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
die()  { bad "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: sudo bash deploy.sh            deploy or update IPTV Hub
       sudo bash deploy.sh --backup   back up the database now
EOF
}

dc() { docker compose --project-directory "$APP_DIR" -f "$APP_DIR/compose.yml" "$@"; }

# Set KEY=VALUE in a file, replacing an existing line or appending a new one.
set_kv() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  if grep -q "^${key}=" "$file"; then sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else printf '%s=%s\n' "$key" "$value" >> "$file"; fi
}
get_kv() { [ -f "$1" ] || return 0; sed -n "s/^$2=//p" "$1" | head -1; }

# ═════════════════════════ steps ═════════════════════════

preflight() {
  step "1) Checking the server"
  [ "$(id -u)" = 0 ] || die "run as root: sudo bash deploy.sh"
  command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"
  docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
  local missing=""
  command -v git >/dev/null || missing="$missing git"
  command -v nginx >/dev/null || missing="$missing nginx"
  command -v certbot >/dev/null || missing="$missing certbot"
  if [ -n "$missing" ]; then
    export DEBIAN_FRONTEND=noninteractive
    # shellcheck disable=SC2086  # one argument per package is intended
    apt-get update -qq && apt-get install -y -qq $missing
    ok "installed:$missing"
  fi
  systemctl is-active --quiet nginx || systemctl enable --now nginx
  ok "docker $(docker version --format '{{.Server.Version}}'), nginx and certbot present"
}

# Clone on the first run, fast-forward afterwards. Local edits stop the update
# rather than being overwritten.
update_code() {
  step "2) Code"
  if [ ! -d "$APP_DIR/.git" ]; then
    [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ] && die "$APP_DIR exists and is not a git clone; move it away first"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    ok "cloned $REPO_URL into $APP_DIR"
    return
  fi
  local before; before="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  [ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ] \
    || die "$APP_DIR has local changes; commit or discard them (git -C $APP_DIR status)"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" merge --quiet --ff-only "origin/$BRANCH" \
    || die "cannot fast-forward $APP_DIR to origin/$BRANCH; fix it by hand"
  local after; after="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  if [ "$before" = "$after" ]; then ok "already at the latest version ($after)"
  else ok "updated $before -> $after"; fi
}

ask_settings() {
  step "3) Settings"
  install -d -m 755 "$CONF_DIR"
  local old_domain old_email domain email
  old_domain="$(get_kv "$CONF" DOMAIN)"; old_email="$(get_kv "$CONF" EMAIL)"
  while :; do
    read -r -p "  Domain${old_domain:+ [$old_domain]}: " domain </dev/tty
    domain="$(printf '%s' "${domain:-$old_domain}" | tr '[:upper:]' '[:lower:]')"
    [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] && break
    bad "not a valid domain: '$domain'"
  done
  while :; do
    read -r -p "  Email for the SSL certificate${old_email:+ [$old_email]}: " email </dev/tty
    email="${email:-$old_email}"
    [[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] && break
    bad "not a valid email: '$email'"
  done
  DOMAIN="$domain"; EMAIL="$email"; OLD_EMAIL="$old_email"
  set_kv "$CONF" DOMAIN "$DOMAIN"
  set_kv "$CONF" EMAIL "$EMAIL"
}

# Let's Encrypt must reach this server on every address the domain publishes.
check_dns() {
  step "4) DNS"
  local ip4 dns4 dns6 ip6s
  ip4="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
  dns4="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ $//' || true)"
  dns6="$(getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '{print $1}' | grep -v '^::ffff:' | sort -u | tr '\n' ' ' | sed 's/ $//' || true)"
  ip6s=" $(ip -6 addr show scope global 2>/dev/null | awk '/inet6/ {sub(/\/.*/, "", $2); print $2}' | tr '\n' ' ')"
  if [ "$dns4" != "$ip4" ]; then
    bad "$DOMAIN resolves to '${dns4:-nothing}', but this server is $ip4"
    cat <<EOF

  ${B}Add this record at your DNS provider, wait until it resolves, then run again:${N}

      ${C}Type: A    Name: ${DOMAIN}    Value: ${ip4}${N}

  (If the domain is behind a proxy such as Cloudflare's orange cloud, switch it to
  DNS only: the proxy would hide this server from Let's Encrypt and from players.)
EOF
    exit 1
  fi
  ok "A    $DOMAIN -> $dns4"
  local a
  for a in $dns6; do
    [[ "$ip6s " == *" $a "* ]] || die "AAAA $DOMAIN -> $a is not an address of this server; fix or delete the AAAA record"
  done
  if [ -n "$dns6" ]; then ok "AAAA $DOMAIN -> $dns6"; fi
}

# A port chosen once is kept forever, so nginx and the container always agree.
pick_port() {
  PORT="$(get_kv "$CONF" PORT)"
  if [ -z "$PORT" ]; then
    local p
    for p in $(seq "$PORT_MIN" "$PORT_MAX"); do
      ss -ltn | awk '{print $4}' | grep -qE "[:.]$p\$" && continue
      grep -rqsE "(:|\b)$p\b" /etc/nginx 2>/dev/null && continue
      PORT="$p"; break
    done
    [ -n "$PORT" ] || die "no free port between $PORT_MIN and $PORT_MAX"
    set_kv "$CONF" PORT "$PORT"
  fi
}

start_app() {
  step "5) Application"
  pick_port
  # Compose reads this file for the port and the backup directory. It is ignored
  # by git, so updates never touch it.
  set_kv "$APP_DIR/.env" IPTVHUB_PORT "$PORT"
  set_kv "$APP_DIR/.env" IPTVHUB_BACKUP_DIR "$BACKUP_DIR"
  chmod 600 "$APP_DIR/.env"
  install -d -m 750 -o "$CONTAINER_UID" -g "$CONTAINER_UID" "$BACKUP_DIR"

  local running=0
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ] && running=1
  if [ "$running" = 1 ]; then backup && ok "backed up the database before updating"; fi

  dc build --pull --quiet
  ok "image built"
  import_db_once
  dc up -d --remove-orphans
  local i
  for i in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/player_api.php" 2>/dev/null && break
    [ "$i" = 60 ] && { dc logs --tail 40; die "the app did not answer on 127.0.0.1:$PORT within 60 seconds"; }
    sleep 1
  done
  ok "running on 127.0.0.1:$PORT (container $CONTAINER, restart: unless-stopped)"
  docker image prune -f >/dev/null 2>&1 || true
}

# If $IMPORT_DB exists and the data volume has no database yet, copy it in once.
import_db_once() {
  [ -f "$IMPORT_DB" ] || return 0
  local result
  result="$(dc run --rm --no-deps -T --user root -v "$IMPORT_DB:/import.db:ro" --entrypoint sh "$CONTAINER" -c \
    'if [ -f /data/catalog.db ]; then echo exists; else cp /import.db /data/catalog.db && chown node:node /data/catalog.db && chmod 600 /data/catalog.db && echo imported; fi' 2>&1 || true)"
  case "$result" in
    *imported*) mv "$IMPORT_DB" "$IMPORT_DB.imported-$(date +%Y%m%d-%H%M%S)"; ok "imported $IMPORT_DB into the data volume" ;;
    *exists*)   warn "$IMPORT_DB was not imported: the data volume already has a database" ;;
    *)          die "importing $IMPORT_DB failed: $result" ;;
  esac
}

render() {
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" -e "s|__ACME_ROOT__|$ACME_ROOT|g" "$1"
}

# Install one site template, test the whole nginx config, and put everything back
# the way it was if the test fails.
apply_nginx() {
  local tpl="$1" T="$APP_DIR/scripts/templates"
  local site=/etc/nginx/sites-available/iptv-hub.conf link=/etc/nginx/sites-enabled/iptv-hub.conf
  local proxy=/etc/nginx/iptv-hub-proxy.conf limits=/etc/nginx/conf.d/iptv-hub-limits.conf
  local f tmp; tmp="$(mktemp -d)"
  for f in "$site" "$proxy" "$limits"; do
    if [ -f "$f" ]; then cp "$f" "$tmp/$(basename "$f")"; fi
  done
  install -d -m 755 "$ACME_ROOT" /etc/nginx/conf.d /etc/nginx/sites-available /etc/nginx/sites-enabled
  render "$T/nginx-proxy.conf" > "$proxy"
  render "$T/nginx-limits.conf" > "$limits"
  render "$T/$tpl" > "$site"
  [ -f /proc/net/if_inet6 ] || sed -i '/\[::\]/d' "$site"   # no IPv6 on this host
  ln -sfn "$site" "$link"
  if ! nginx -t >"$tmp/nginx-t.log" 2>&1; then
    cat "$tmp/nginx-t.log" >&2
    for f in "$site" "$proxy" "$limits"; do
      if [ -f "$tmp/$(basename "$f")" ]; then cp "$tmp/$(basename "$f")" "$f"; else rm -f "$f"; fi
    done
    [ -f "$site" ] || rm -f "$link"
    rm -rf "$tmp"
    die "nginx rejected the new config; the previous files were restored"
  fi
  rm -rf "$tmp"
  systemctl reload nginx
}

configure_nginx_and_tls() {
  step "6) nginx and certificate"
  local cert="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"

  if [ ! -f "$cert" ]; then
    apply_nginx nginx-http.conf
    ok "nginx serves $DOMAIN over HTTP (needed for the certificate challenge)"
    certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --cert-name "$DOMAIN" \
      -m "$EMAIL" --agree-tos --no-eff-email --non-interactive --keep-until-expiring \
      || die "certificate request failed; the site works over HTTP. Check DNS and port 80, then run again"
    ok "certificate issued for $DOMAIN"
    NEW_CERT=1
  else
    ok "certificate for $DOMAIN already present (expires $(openssl x509 -enddate -noout -in "$cert" | cut -d= -f2))"
    if [ -n "$OLD_EMAIL" ] && [ "$EMAIL" != "$OLD_EMAIL" ]; then
      certbot update_account -m "$EMAIL" --no-eff-email --non-interactive >/dev/null && ok "Let's Encrypt contact email updated"
    fi
  fi

  apply_nginx nginx-ssl.conf
  ok "nginx serves https://$DOMAIN; player paths stay on plain HTTP on purpose"

  # Renewal: certbot's own timer renews; this hook reloads nginx afterwards so the
  # new certificate is actually served.
  install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\n# Installed by IPTV Hub deploy.sh: serve renewed certificates.\nsystemctl reload nginx\n' \
    > /etc/letsencrypt/renewal-hooks/deploy/iptv-hub-reload-nginx.sh
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/iptv-hub-reload-nginx.sh
  if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then systemctl enable --now certbot.timer >/dev/null 2>&1
  elif systemctl list-unit-files snap.certbot.renew.timer >/dev/null 2>&1; then systemctl enable --now snap.certbot.renew.timer >/dev/null 2>&1
  else die "no certbot renewal timer found (certbot.timer or snap.certbot.renew.timer)"; fi
  ok "automatic renewal: $(systemctl list-timers --all --no-legend 2>/dev/null | awk '/certbot/ {print "next run " $1, $2, $3; exit}')"
  if [ "${NEW_CERT:-0}" = 1 ]; then
    if certbot renew --dry-run --cert-name "$DOMAIN" --no-random-sleep-on-renew >/dev/null 2>&1; then ok "renewal dry run succeeded"
    else warn "renewal dry run failed: run 'certbot renew --dry-run' to see why"; fi
  fi
}

# Consistent copy of the live database via VACUUM INTO, keeping the last $KEEP.
backup() {
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
    warn "container $CONTAINER is not running; nothing to back up"; return 0
  fi
  local name; name="catalog-$(date +%Y%m%d-%H%M%S).db"
  dc exec -T "$CONTAINER" node --no-warnings -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/catalog.db');
    db.exec(\"VACUUM INTO '/backups/$name'\");
    db.close();
  " || { bad "backup failed"; return 1; }
  chmod 640 "$BACKUP_DIR/$name"
  # shellcheck disable=SC2012  # file names are our own timestamps
  ls -1t "$BACKUP_DIR"/catalog-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  if [ -t 1 ]; then ok "backup written: $BACKUP_DIR/$name ($(du -h "$BACKUP_DIR/$name" | cut -f1))"; fi
}

install_backup_timer() {
  step "7) Daily backups"
  cat > /etc/systemd/system/iptv-hub-backup.service <<EOF
[Unit]
Description=IPTV Hub daily database backup
After=docker.service
[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/deploy.sh --backup
EOF
  cat > /etc/systemd/system/iptv-hub-backup.timer <<EOF
[Unit]
Description=IPTV Hub daily database backup
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30m
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now iptv-hub-backup.timer >/dev/null 2>&1
  ok "daily backups to $BACKUP_DIR, keeping the last $KEEP"
}

summary() {
  local pass
  pass="$(dc exec -T "$CONTAINER" node --no-warnings -e "
    if (process.env.ADMIN_TOKEN) { console.log(process.env.ADMIN_TOKEN); process.exit(0); }
    const { DatabaseSync } = require('node:sqlite');
    const r = new DatabaseSync('/data/catalog.db', { readOnly: true }).prepare(\"SELECT v FROM kv WHERE k='admin_token'\").get();
    console.log(r ? r.v : '?');
  " 2>/dev/null | tr -d '\r' || true)"
  step "Done"
  cat <<EOF

  Web interface:  ${C}https://$DOMAIN${N}
  Username:       ${C}admin${N}
  Password:       ${C}${pass:-?}${N}

  Player (TiviMate / IPTV Smarters), playlist type Xtream Codes:
      ${C}http://$DOMAIN${N}   or   ${C}https://$DOMAIN${N}

  Logs:     docker compose -f $APP_DIR/compose.yml logs -f
  Update:   sudo bash $APP_DIR/deploy.sh
  Backup:   sudo bash $APP_DIR/deploy.sh --backup   (daily, to $BACKUP_DIR)

EOF
}

main() {
  case "${1:-}" in
    --backup)
      [ "$(id -u)" = 0 ] || die "run as root"
      exec 9>"$LOCK"; flock -w 600 9 || die "another deploy is still running"
      backup; exit ;;
    -h|--help) usage; exit 0 ;;
    "") ;;
    *) usage; die "unknown option: $1" ;;
  esac

  # Phase one updates the code, then hands over to the freshly pulled copy of
  # this script, so an update always runs with the new deployment logic.
  if [ -z "${IPTVHUB_UPDATED:-}" ]; then
    preflight
    update_code
    exec env IPTVHUB_UPDATED=1 bash "$APP_DIR/deploy.sh" "$@"
  fi

  exec 9>"$LOCK"; flock -n 9 || die "another deploy is already running"
  ask_settings
  check_dns
  start_app
  configure_nginx_and_tls
  install_backup_timer
  summary
}

# Everything runs from main(), which bash reads in full before starting, so a git
# pull that rewrites this file mid-run cannot break the run in progress.
main "$@"
