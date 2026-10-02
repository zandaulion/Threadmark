#!/usr/bin/env python3
"""Register Threadmark with the existing tailnet-only PWA invite console."""
import json
import os
from pathlib import Path
import pwd
import re
import subprocess

CADDYFILE = Path(os.environ.get('THREADMARK_CADDYFILE', '/etc/caddy/Caddyfile'))
APPS = Path(os.environ.get('THREADMARK_CONSOLE_APPS', '/var/www/pwa-invite-console/apps.json'))
OWNER_HOME = Path(pwd.getpwnam(os.environ.get('SUDO_USER', pwd.getpwuid(os.getuid()).pw_name)).pw_dir)
ENVFILE = Path(os.environ.get('THREADMARK_ENV_FILE', str(OWNER_HOME / '.config/threadmark/server.env')))
ANCHOR = os.environ.get('THREADMARK_CONSOLE_ANCHOR', '\t# The train API, tailnet-only.')
MARKER = '# Threadmark invite console route.'

def replace(path, content):
    previous = path.stat()
    temporary = path.with_name(path.name + '.threadmark-new')
    temporary.write_text(content)
    os.chown(temporary, previous.st_uid, previous.st_gid)
    os.chmod(temporary, previous.st_mode)
    temporary.replace(path)

def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run with sudo')
    if not all(path.exists() for path in (CADDYFILE, APPS, ENVFILE)):
        raise RuntimeError('Expected the Caddyfile, invite console apps.json and Threadmark environment file')
    match = re.search(r'^ADMIN_TOKEN=([a-f0-9]{64})$', ENVFILE.read_text(), re.MULTILINE)
    if not match:
        raise RuntimeError('ADMIN_TOKEN is missing or malformed')
    token = match.group(1)
    current = CADDYFILE.read_text()
    if MARKER not in current:
        if current.count(ANCHOR) != 1:
            raise RuntimeError('Cannot locate the private console route insertion point')
        route = (
            f'\t{MARKER}\n'
            '\thandle /threadmark/api/* {\n'
            '\t\turi strip_prefix /threadmark\n'
            '\t\treverse_proxy 127.0.0.1:4391 {\n'
            f'\t\t\theader_up X-Admin-Token {token}\n'
            '\t\t}\n'
            '\t}\n\n'
        )
        current = current.replace(ANCHOR, route + ANCHOR)

    apps = json.loads(APPS.read_text())
    entry = {
        'id': 'threadmark',
        'name': 'Threadmark',
        'description': 'Payments and meetings detected from selected WhatsApp chats',
        'icon': 'icons/apps/threadmark.svg',
        'api': '/threadmark',
        'invite_kind': 'device',
        'push': True,
        'message': 'Threadmark access:\n\n1) Open {link}\n2) Install the app.\n3) Activate this device with the invitation code.\n\nThe code is valid for {days} days and registers one device.'
    }
    apps = [entry if app.get('id') == 'threadmark' else app for app in apps]
    if not any(app.get('id') == 'threadmark' for app in apps):
        apps.append(entry)
    backup = CADDYFILE.with_suffix('.threadmark-backup')
    backup.write_bytes(CADDYFILE.read_bytes())
    replace(CADDYFILE, current)
    check = subprocess.run(['caddy', 'validate', '--config', str(CADDYFILE)], capture_output=True, text=True)
    if check.returncode:
        replace(CADDYFILE, backup.read_text())
        raise RuntimeError(check.stderr.strip() or 'Caddy validation failed')
    replace(APPS, json.dumps(apps, ensure_ascii=False, indent=2) + '\n')
    icon_source = Path(__file__).parents[1] / 'app/web/icons/icon.svg'
    icon_target = APPS.parent / 'icons/apps/threadmark.svg'
    icon_target.parent.mkdir(parents=True, exist_ok=True)
    icon_target.write_bytes(icon_source.read_bytes())
    subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
    print('Threadmark was added to the private invitation console.')

if __name__ == '__main__':
    main()
