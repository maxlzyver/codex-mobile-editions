#!/usr/bin/env python3
"""Generate or verify the distributable plugin manifest and reproducible ZIP.

The checked-in mcp.json is a portable template. Per-machine configuration and
the installed plugin cache are never packaging inputs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'plugins/codex-mobile'
ROOT_FILES = {'plugin.json', 'mcp.json', 'package.json', 'README.md', 'LICENSE',
              'THIRD_PARTY_NOTICES.md', 'Install-Plugin.ps1', 'Install-Plugin.command'}
PUBLIC_DIRS = {'dist', 'ui', 'scripts', 'skills', 'assets', 'licenses', 'lib', '.codex-plugin'}
EXCLUDED_FILES = {'build.mjs', 'test-ui.mjs', 'app.js', 'app.css', 'template.html'}
REQUIRED = {'plugin.json', 'package.json', '.codex-plugin/plugin.json', 'mcp.json', 'dist/server.mjs', 'ui/app.html',
            'skills/mobile/SKILL.md', 'skills/setup/SKILL.md', 'README.md', 'LICENSE'}
PRIVATE = {'.runtime', '.git', '.codex', 'node_modules', 'test', 'tests', 'work',
           'workspace', 'config.json', 'owner-url.txt', 'auth.json', 'devices.json'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')


def regular(filename):
    require(filename.is_file(), f'Missing file: {filename}')
    for part in [filename, *filename.parents]:
        require(not part.is_symlink() and not (hasattr(part, 'is_junction') and part.is_junction()), f'Linked input: {part}')


def plan():
    files = []
    for name in sorted(ROOT_FILES):
        file = SOURCE / name
        regular(file)
        files.append(file)
    for folder in sorted(PUBLIC_DIRS):
        base = SOURCE / folder
        if not base.exists():
            continue
        for current, directories, filenames in os.walk(base, followlinks=False):
            for name in directories:
                child = Path(current) / name
                require(not child.is_symlink() and not (hasattr(child, 'is_junction') and child.is_junction()), f'Linked directory: {child}')
            directories[:] = sorted(name for name in directories if name not in PRIVATE)
            for name in sorted(filenames):
                if name in EXCLUDED_FILES:
                    continue
                files.append(Path(current) / name)
    entries, seen = {}, set()
    for file in files:
        regular(file)
        relative = file.relative_to(SOURCE).as_posix()
        parts = relative.split('/')
        require(not set(parts) & PRIVATE and not any(part.startswith('.env') for part in parts), f'Private input: {relative}')
        require(all(not part.startswith('.') or part == '.codex-plugin' for part in parts), f'Hidden input: {relative}')
        require(file.suffix.lower() not in {'.log', '.db', '.sqlite', '.key', '.pem', '.zip', '.map'}, f'Non-distributable input: {relative}')
        require(relative.lower() not in seen, f'Duplicate path: {relative}')
        seen.add(relative.lower())
        entries[relative] = file.read_bytes()
    require(REQUIRED <= set(entries), f'Missing required plugin files: {REQUIRED - set(entries)}')
    profile = json.loads(entries['plugin.json'])
    version = profile.get('version', '')
    require(profile.get('name') == 'codex-mobile' and re.fullmatch(r'\d+\.\d+\.\d+', version), 'Invalid plugin identity')
    require(json.loads(entries['package.json'])['version'] == version, 'Plugin package version mismatch')
    require(json.loads(entries['.codex-plugin/plugin.json'])['version'] == version, 'Plugin compatibility version mismatch')
    mcp = json.loads(entries['mcp.json'])
    require(mcp['mcpServers']['mobile']['command'] == '__CODEX_MOBILE_BUNDLED_NODE__', 'Do not publish a materialized local MCP command')
    notes_file = ROOT / f'docs/V{version}-UPDATE-NOTES.md'
    if not notes_file.is_file():
        notes_file = ROOT / 'editions/windows11/docs/UPDATE-NOTES.md'
    notes = notes_file.read_text(encoding='utf-8').strip()
    manifest = {'schema': 1, 'name': 'codex-mobile', 'version': version, 'releaseNotes': notes,
                'files': [{'path': name, 'bytes': len(data), 'sha256': digest(data)} for name, data in sorted(entries.items())]}
    return version, entries, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--dry-run', action='store_true')
    modes.add_argument('--build', action='store_true')
    modes.add_argument('--verify', action='store_true')
    parser.add_argument('--output-dir', type=Path, default=ROOT.parent)
    parser.add_argument('--replace', action='store_true')
    args = parser.parse_args()
    version, entries, manifest = plan()
    manifest_bytes = encoded(manifest)
    if args.verify:
        require((SOURCE / 'update.json').read_bytes() == manifest_bytes, 'Plugin manifest differs from source files; rebuild it')
    elif args.build:
        output = args.output_dir.resolve()
        output.mkdir(parents=True, exist_ok=True)
        name = f'codex-mobile-plugin-{version}.zip'
        destination = output / name
        checksums = output / f'SHA256SUMS-plugin-{version}.txt'
        require(args.replace or not (destination.exists() or checksums.exists()), 'Plugin release files already exist; choose a new version or --replace')
        payloads = {**entries, 'update.json': manifest_bytes}
        # The convenient ZIP-root entry is an alias of the updater-compatible
        # scripts/ entry. V1.3.0's updater rejects new root program filenames.
        if 'scripts/Install-Plugin.cmd' in entries:
            payloads['Install-Plugin.cmd'] = entries['scripts/Install-Plugin.cmd']
        with tempfile.NamedTemporaryFile(dir=output, prefix='.plugin-', suffix='.tmp', delete=False) as handle:
            temporary = Path(handle.name)
        try:
            with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
                for relative, data in sorted(payloads.items()):
                    info = zipfile.ZipInfo('codex-mobile-plugin/' + relative, date_time=(2020, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    mode = 0o755 if relative.endswith('.command') else 0o644
                    info.external_attr = (stat.S_IFREG | mode) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, data)
            with zipfile.ZipFile(temporary) as archive:
                require(len(archive.infolist()) == len(payloads), 'Duplicate ZIP entry')
                for relative, data in payloads.items():
                    require(archive.read('codex-mobile-plugin/' + relative) == data, f'ZIP mismatch: {relative}')
            # Do not commit a partial manifest while ZIP validation is pending.
            (SOURCE / 'update.json').write_bytes(manifest_bytes)
            os.replace(temporary, destination)
            checksums.write_text(digest(destination.read_bytes()) + '  ' + name + '\n', encoding='ascii')
        finally:
            temporary.unlink(missing_ok=True)
    print(json.dumps({'ok': True, 'version': version, 'files': len(entries), 'manifestSha256': digest(manifest_bytes),
                      'mode': 'build' if args.build else 'verify' if args.verify else 'dry-run'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
