"""Read-only audit of checked-in update folders. No runtime or credentials needed."""
import argparse, hashlib, json, pathlib
p = argparse.ArgumentParser()
p.add_argument('--edition', choices=['windows10','windows11','macos'])
args = p.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
editions = [args.edition] if args.edition else ['windows10','windows11','macos']
for name in editions:
    directory = root / 'editions' / name
    profile = json.loads((directory / 'edition.json').read_text(encoding='utf-8-sig'))
    update = json.loads((directory / 'update.json').read_text(encoding='utf-8-sig'))
    assert profile['id'] == update['edition'] == name
    assert profile['version'] == update['version']
    assert update['repository'] == 'maxlzyver/codex-mobile-editions'
    assert update['platform'] == profile['platform']
    assert update['runtimePolicy'] == 'preserve'
    assert profile['updatePath'] == f'editions/{name}'
    seen = set()
    for entry in update['files']:
        relative = pathlib.PurePosixPath(entry['path'])
        assert not relative.is_absolute() and '..' not in relative.parts
        assert not set(relative.parts) & {'.runtime','.git','.codex','workspace','node_modules','work'}
        assert relative.as_posix().lower() not in seen
        seen.add(relative.as_posix().lower())
        file = directory.joinpath(*relative.parts)
        assert file.is_file() and not file.is_symlink()
        payload = file.read_bytes()
        assert len(payload) == entry['bytes'], str(file)
        assert hashlib.sha256(payload).hexdigest() == entry['sha256'], str(file)
    assert 'edition.json' in seen
    print(f'{name}: {len(seen)} verified update files; version {profile["version"]}')
