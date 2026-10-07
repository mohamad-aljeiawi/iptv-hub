#!/usr/bin/env bash
# Shortcut: sudo ./install.sh --domain iptv.example.com --email you@example.com
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/install.sh" "$@"
