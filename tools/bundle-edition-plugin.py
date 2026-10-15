#!/usr/bin/env python3
"""Embed the complete public plugin in each edition without hidden ZIP paths.

Run after building the plugin; --verify checks the committed payloads.
No installed plugin, account configuration or private runtime is read.
"""
import argparse
import base64
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDITIONS = ('windows11', 'windows10', 'macos')


def bundle_bytes():
    spec = importlib.util.spec_from_file_location('edition_plugin_packager', ROOT / 'tools/package-plugin.py')
    packager = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(packager)
    version, entries, manifest = packager.plan()
    entries = {**entries, 'update.json': packager.encoded(manifest)}
    payload = {'schema': 1, 'name': 'codex-mobile', 'version': version,
               'files': [{'path': name, 'bytes': len(data), 'sha256': packager.digest(data),
                          'data': base64.b64encode(data).decode('ascii')}
                         for name, data in sorted(entries.items())]}
    content = packager.encoded(payload)
    if len(content) > 40 * 1024 * 1024:
        raise ValueError('Embedded plugin exceeds the extraction limit')
    return content, version, len(entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--write', action='store_true')
    mode.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    writing = not args.verify
    content, version, count = bundle_bytes()
    for edition in EDITIONS:
        target = ROOT / 'editions' / edition / 'lib/plugin-bundle.json'
        if writing:
            target.write_bytes(content)
        elif not target.is_file() or target.read_bytes() != content:
            raise ValueError(f'{edition}: plugin bundle is stale; run tools/bundle-edition-plugin.py --write')
    print(json.dumps({'ok': True, 'version': version, 'files': count, 'bytes': len(content),
                      'editions': list(EDITIONS), 'mode': 'write' if writing else 'verify'}))


if __name__ == '__main__':
    main()
