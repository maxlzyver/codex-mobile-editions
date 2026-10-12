#!/usr/bin/env python3
"""Build clean, reproducible portable ZIPs and edition-specific folder manifests.

First inspect:  python tools/package-editions.py --dry-run
Then publish:  python tools/package-editions.py --build

Only --build writes editions/<id>/update.json and the ZIP/checksum/audit files.
Private runtime directories and the legacy package-release.mjs are never read
or packaged. Existing source files are not removed or rewritten. Local download
paths in macOS runtime provenance are removed from their ZIP copies only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass

REPOSITORY = "maxlzyver/codex-mobile-editions"
ROOT = Path(__file__).resolve().parents[1]
EDITIONS = {
    "windows11": ("Windows 11 x64", "x64"),
    "windows10": ("Windows 10 x64", "x64"),
    "macos": ("macOS universal", "universal"),
}
SEMVER = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\Z")
COMMON_ROOT = {"edition.json", "package.json", "server.mjs", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"}
WINDOWS_ROOT = {"Start.cmd", "Stop.cmd", "Launch.ps1", "Stop.ps1", "Codex-Mobile.exe", "build-launcher.ps1"}
MAC_ROOT = {"Start.command", "Stop.command", "Login.command"}
COMMON_DIRS = {"lib", "public", "docs"}
PRIVATE_PARTS = {".runtime", ".codex", ".git", "workspace", "work", "node_modules", "__pycache__", ".DS_Store"}
PRIVATE_NAMES = {"owner-url.txt", "auth.json", "devices.json", "tasks.json", "sessions.json", "credentials.json"}
PRIVATE_EXTENSIONS = {".log", ".db", ".sqlite", ".key", ".pem", ".pfx", ".zip", ".tgz", ".gz", ".pyc"}
ZIP_TIME = (2020, 1, 1, 0, 0, 0)
MAX_RELEASE_NOTES = 12000


class PackagingError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PackagingError(message)


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def file_hash(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(filename: Path) -> None:
    require(filename.is_file() and not filename.is_symlink(), f"Required regular file is missing: {filename}")
    for parent in filename.parents:
        require(not parent.is_symlink(), f"Symlink/junction is not a release source: {parent}")
        if hasattr(parent, "is_junction"):
            require(not parent.is_junction(), f"Junction is not a release source: {parent}")


def read_json(filename: Path):
    regular_file(filename)
    require(filename.stat().st_size <= 8 * 1024 * 1024, f"Oversized JSON: {filename.name}")
    try:
        return json.loads(filename.read_text(encoding="utf-8-sig"))
    except (ValueError, UnicodeError) as error:
        raise PackagingError(f"Invalid UTF-8 JSON: {filename}") from error


def safe_relative(relative: str) -> None:
    parts = PurePosixPath(relative).parts
    require(bool(parts) and not relative.startswith("/") and "\\" not in relative, f"Unsafe relative path: {relative}")
    require(all(part not in ("", ".", "..") and not part.startswith(".") and not part.endswith((".", " ")) for part in parts), f"Unsafe path components: {relative}")
    require(not any(part in PRIVATE_PARTS or part.startswith(".env") for part in parts), f"Private path selected: {relative}")
    require(PurePosixPath(relative).name.lower() not in PRIVATE_NAMES, f"Private file selected: {relative}")
    require(PurePosixPath(relative).suffix.lower() not in PRIVATE_EXTENSIONS, f"Private/archive artifact selected: {relative}")


def walk_public(directory: Path, base: Path):
    require(directory.is_dir() and not directory.is_symlink(), f"Required source directory is missing: {directory}")
    for current, directories, filenames in os.walk(directory, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in PRIVATE_PARTS and not name.startswith(".env"))
        for name in directories:
            folder = Path(current) / name
            require(not folder.is_symlink() and not (hasattr(folder, "is_junction") and folder.is_junction()), f"Linked source directory: {folder}")
        for name in sorted(filenames):
            if name in PRIVATE_PARTS or name.startswith(".env"):
                continue
            filename = Path(current) / name
            regular_file(filename)
            relative = filename.relative_to(base).as_posix()
            safe_relative(relative)
            yield relative


def profile_for(edition: str, base: Path):
    profile = read_json(base / "edition.json")
    platform, architecture = EDITIONS[edition]
    version = profile.get("version", "")
    require(isinstance(version, str) and bool(SEMVER.fullmatch(version)), f"Invalid stable version for {edition}")
    expected_asset = f"codex-mobile-{edition}-{version}-{architecture}.zip"
    require(profile.get("id") == edition and profile.get("platform") == platform and profile.get("repository") == REPOSITORY
            and profile.get("updatePath") == f"editions/{edition}" and profile.get("assetName") == expected_asset,
            f"Edition identity/source mismatch: {edition}")
    package = read_json(base / "package.json")
    require(package.get("version") == version and package.get("name") == "codex-mobile-console", f"package.json version/name mismatch: {edition}")
    return profile


def sanitized_provenance(value):
    """Keep remote provenance and digests; do not disclose the build machine path."""
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            if key.lower() in {"path", "localpath", "downloadpath", "archivepath", "cwd", "home"}:
                continue
            if isinstance(child, str) and (re.match(r"^[A-Za-z]:[\\/]", child) or child.startswith(("/Users/", "/home/", "/tmp/"))):
                continue
            result[key] = sanitized_provenance(child)
        return result
    if isinstance(value, list):
        return [sanitized_provenance(child) for child in value]
    return value


@dataclass(frozen=True)
class Entry:
    relative: str
    source: Path | None
    size: int
    sha256: str
    mode: int = 0o644
    payload: bytes | None = None
    transformed: bool = False

    def record(self):
        return {"path": self.relative, "bytes": self.size, "sha256": self.sha256}


def entry_for(base: Path, relative: str, edition: str) -> Entry:
    safe_relative(relative)
    filename = base / relative
    regular_file(filename)
    mode = 0o755 if relative.endswith((".command", ".exe")) or re.fullmatch(r"runtime/darwin-(?:arm64|x64)/bin/node|vendor/cloudflared-darwin-(?:arm64|x64)", relative) else 0o644
    if edition == "macos" and re.fullmatch(r"runtime/(?:darwin-(?:arm64|x64)/)?source\.json", relative):
        original = filename.read_bytes()
        payload = json_bytes(sanitized_provenance(read_json(filename)))
        return Entry(relative, filename, len(payload), sha256(payload), mode, payload, payload != original)
    if relative.endswith(".command"):
        payload = filename.read_bytes()
        require(b"\r" not in payload and payload.startswith(b"#!/bin/"), f"Mac command must be LF with a shell shebang: {relative}")
        payload.decode("utf-8")
    return Entry(relative, filename, filename.stat().st_size, file_hash(filename), mode)


def binary_header(filename: Path, edition: str, architecture: str | None = None) -> None:
    regular_file(filename)
    with filename.open("rb") as handle:
        header = handle.read(32)
    if edition != "macos":
        require(header.startswith(b"MZ"), f"Expected Windows PE executable: {filename.name}")
        return
    magics = {b"\xcf\xfa\xed\xfe": "little", b"\xfe\xed\xfa\xcf": "big"}
    require(header[:4] in magics, f"Expected a native 64-bit Mach-O executable: {filename.name}")
    cpu = int.from_bytes(header[4:8], magics[header[:4]])
    require(cpu == {"arm64": 0x0100000C, "x64": 0x01000007}[architecture], f"Mach-O architecture mismatch: {architecture}/{filename.name}")


def selected_paths(base: Path, edition: str, include_tests: bool):
    paths = set(COMMON_ROOT | (MAC_ROOT if edition == "macos" else WINDOWS_ROOT))
    directories = set(COMMON_DIRS)
    if edition != "macos":
        directories.add("launcher")
    if include_tests:
        directories.add("test")
    for directory in sorted(directories):
        paths.update(walk_public(base / directory, base))
    paths.update({"vendor/qrcode.cjs", "vendor/qrcode-LICENSE.txt", "vendor/cloudflared-LICENSE.txt"})
    if edition == "macos":
        paths.add("tools/apply-update.mjs")
        for architecture in ("arm64", "x64"):
            paths.update({f"runtime/darwin-{architecture}/bin/node", f"runtime/darwin-{architecture}/LICENSE", f"runtime/darwin-{architecture}/source.json",
                          f"vendor/cloudflared-darwin-{architecture}", f"vendor/cloudflared-darwin-{architecture}.json"})
            binary_header(base / f"runtime/darwin-{architecture}/bin/node", edition, architecture)
            binary = base / f"vendor/cloudflared-darwin-{architecture}"
            binary_header(binary, edition, architecture)
            require(read_json(base / f"vendor/cloudflared-darwin-{architecture}.json").get("sha256") == file_hash(binary), f"cloudflared checksum mismatch: {edition}/{architecture}")
        require(all(PurePosixPath(relative).suffix.lower() not in {".exe", ".dll", ".ps1", ".cmd", ".cs"} and not relative.startswith("launcher/") for relative in paths), "Mac package contains Windows files")
    else:
        paths.update({"tools/apply-update.ps1", "runtime/node.exe", "runtime/LICENSE", "vendor/cloudflared-windows-amd64.exe", "vendor/cloudflared-release.json"})
        for relative in ("Codex-Mobile.exe", "runtime/node.exe", "vendor/cloudflared-windows-amd64.exe"):
            binary_header(base / relative, edition)
        require(read_json(base / "vendor/cloudflared-release.json").get("sha256") == file_hash(base / "vendor/cloudflared-windows-amd64.exe"), f"cloudflared checksum mismatch: {edition}")
        require(all(not relative.endswith(".command") and "darwin-" not in relative and relative != "tools/apply-update.mjs" for relative in paths), "Windows package contains Mac files")
    paths.discard("tools/package-release.mjs")
    return sorted(paths)


def plan_edition(edition: str, include_tests=False):
    base = ROOT / "editions" / edition
    profile = profile_for(edition, base)
    entries = [entry_for(base, relative, edition) for relative in selected_paths(base, edition, include_tests)]
    require(len({entry.relative.casefold() for entry in entries}) == len(entries), f"Case-colliding release paths: {edition}")
    light_entries = [entry for entry in entries if not entry.relative.startswith(("runtime/", "vendor/cloudflared"))]
    require(any(entry.relative == "edition.json" for entry in light_entries), "Update identity was omitted")
    manifest = {"name": "Codex 移动助手", "edition": edition, "version": profile["version"], "platform": profile["platform"],
                "repository": REPOSITORY, "runtimePolicy": "preserve", "releaseNotes": read_release_notes(base),
                "files": [entry.record() for entry in light_entries]}
    content = json_bytes(manifest)
    entries.append(Entry("update.json", None, len(content), sha256(content), payload=content))
    entries.sort(key=lambda entry: entry.relative)
    return {"edition": edition, "base": base, "profile": profile, "entries": entries, "manifest": manifest, "manifestBytes": content}


def read_release_notes(base: Path) -> str:
    filename = base / "docs" / "UPDATE-NOTES.md"
    regular_file(filename)
    require(filename.stat().st_size <= 48000, "Update notes exceed 48000 UTF-8 bytes")
    try:
        notes = filename.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n").strip()
    except UnicodeError as error:
        raise PackagingError("Update notes must be UTF-8 text") from error
    require(len(notes.encode("utf-16-le")) // 2 <= MAX_RELEASE_NOTES, "Update notes exceed 12000 characters")
    require(not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", notes), "Update notes contain control characters")
    return notes


def manifest_write(plan) -> None:
    # Exact deterministic bytes are also embedded in the ZIP; no generated time.
    destination = plan["base"] / "update.json"
    with tempfile.NamedTemporaryFile(dir=plan["base"], prefix=".update-", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(plan["manifestBytes"])
    try:
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def assert_sources_unchanged(plan) -> None:
    for entry in plan["entries"]:
        if entry.source is None or entry.transformed:
            continue
        require(entry.source.stat().st_size == entry.size and file_hash(entry.source) == entry.sha256,
                f"Source changed during packaging; rerun after edits finish: {plan['edition']}/{entry.relative}")


def write_zip(plan, destination: Path):
    prefix = f"codex-mobile-{plan['edition']}/"
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".package-", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=False) as archive:
            for entry in plan["entries"]:
                info = zipfile.ZipInfo(prefix + entry.relative, date_time=ZIP_TIME)
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | entry.mode) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                info._compresslevel = 9
                digest = hashlib.sha256()
                received = 0
                with archive.open(info, "w") as target:
                    if entry.payload is not None:
                        target.write(entry.payload); digest.update(entry.payload); received = len(entry.payload)
                    else:
                        with entry.source.open("rb") as source:
                            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                                target.write(chunk); digest.update(chunk); received += len(chunk)
                require(received == entry.size and digest.hexdigest() == entry.sha256, f"Source changed while writing ZIP: {entry.relative}")
        audit_zip(plan, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def audit_zip(plan, filename: Path):
    expected = {f"codex-mobile-{plan['edition']}/{entry.relative}": entry for entry in plan["entries"]}
    with zipfile.ZipFile(filename) as archive:
        require(len(archive.infolist()) == len(expected) and set(archive.namelist()) == set(expected), "ZIP entry inventory differs from plan")
        for info in archive.infolist():
            entry = expected[info.filename]
            require(info.file_size == entry.size and stat.S_IMODE(info.external_attr >> 16) == entry.mode, f"ZIP size/mode mismatch: {entry.relative}")
            digest = hashlib.sha256()
            with archive.open(info) as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            require(digest.hexdigest() == entry.sha256, f"ZIP checksum mismatch: {entry.relative}")
        embedded = json.loads(archive.read(f"codex-mobile-{plan['edition']}/update.json"))
        require(embedded == plan["manifest"], "Embedded update manifest changed")
    return True


def audit_record(plan, archive=None):
    profile = plan["profile"]
    record = {"edition": profile["id"], "version": profile["version"], "platform": profile["platform"], "assetName": profile["assetName"],
              "zipRoot": f"codex-mobile-{profile['id']}", "fileCount": len(plan["entries"]), "uncompressedBytes": sum(entry.size for entry in plan["entries"]),
              "updateFileCount": len(plan["manifest"]["files"]), "updateManifestSha256": sha256(plan["manifestBytes"]),
              "zipOnlySanitizedFiles": [entry.relative for entry in plan["entries"] if entry.transformed],
              "files": [{**entry.record(), "mode": f"{entry.mode:04o}"} for entry in plan["entries"]],
              "checks": {"privateDataExcluded": True, "legacyPackagerExcluded": True, "matchingPlatformOnly": True,
                         "matchingEditionIdentity": True, "manifestSelfHashExcluded": True, "macCommandsLF": True}}
    if archive:
        record.update({"bytes": archive.stat().st_size, "sha256": file_hash(archive), "zipVerified": True})
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Validate and list exact files without changing manifests or archives")
    mode.add_argument("--build", action="store_true", help="Write edition update.json files, portable ZIPs, checksums and audit")
    parser.add_argument("--edition", choices=tuple(EDITIONS), action="append", help="Only package selected edition(s); defaults to all three")
    parser.add_argument("--output-dir", type=Path, default=ROOT.parent, help="ZIP/checksum/audit directory (default: outputs)")
    parser.add_argument("--include-tests", action="store_true", help="Include edition test source files in both update manifest and ZIP")
    parser.add_argument("--replace", action="store_true", help="Explicitly replace already generated ZIP/checksum/audit files")
    parser.add_argument("--release-label", help="Checksum/audit batch label; required when selected edition versions differ")
    parser.add_argument("--prepare-audit", type=Path, help="Attach isolated Prepare results after matching each exact update manifest digest")
    args = parser.parse_args(argv)
    selected = args.edition or list(EDITIONS)
    require(len(set(selected)) == len(selected), "Duplicate --edition")
    plans = [plan_edition(edition, args.include_tests) for edition in selected]
    versions = {plan["profile"]["version"] for plan in plans}
    label = args.release_label or (next(iter(versions)) if len(versions) == 1 else None)
    require(label is not None and bool(re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}", label)), "Provide a safe --release-label for a batch with different edition versions")
    output = args.output_dir.resolve()
    checksum_name, audit_name = f"SHA256SUMS-editions-{label}.txt", f"PACKAGING-AUDIT-editions-{label}.json"
    report = {"schema": 1, "repository": REPOSITORY, "mode": "dry-run" if args.dry_run else "build", "releaseLabel": label,
              "reproducibleZipTimestamp": "2020-01-01T00:00:00Z", "testSourcesIncluded": args.include_tests,
              "checksumFile": checksum_name, "auditFile": audit_name,
              "excluded": ["private runtime data", "user projects", "test output", "old tools/package-release.mjs", "other-platform launchers and runtime components"]}
    if args.prepare_audit:
        evidence = read_json(args.prepare_audit)
        require(isinstance(evidence, list), "Prepare audit must be an array")
        verified = []
        for plan in plans:
            matches = [item for item in evidence if item.get("edition") == plan["edition"]]
            require(len(matches) == 1, f"Missing unique Prepare audit: {plan['edition']}")
            item = matches[0]
            require(item.get("status") == "prepared" and item.get("programModified") is False
                    and item.get("manifestSha256") == sha256(plan["manifestBytes"])
                    and item.get("targetVersion") == plan["profile"]["version"]
                    and item.get("verifiedFiles") == len(plan["manifest"]["files"]) + 1,
                    f"Prepare evidence does not match current files: {plan['edition']}")
            verified.append({key: item[key] for key in ("edition", "status", "programModified", "manifestSha256", "targetVersion", "verifiedFiles")})
        report["isolatedPrepareValidation"] = {"hostPlatform": sys.platform, "actualInstallationPerformed": False, "results": verified}
    if args.dry_run:
        report["editions"] = [audit_record(plan) for plan in plans]
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    output.mkdir(parents=True, exist_ok=True)
    destinations = [output / plan["profile"]["assetName"] for plan in plans] + [output / checksum_name, output / audit_name]
    require(args.replace or not any(destination.exists() for destination in destinations), "Release output already exists; use a new version or explicitly --replace")
    for plan in plans:
        assert_sources_unchanged(plan)
    records = []
    for plan in plans:
        manifest_write(plan)
        archive = output / plan["profile"]["assetName"]
        write_zip(plan, archive)
        records.append(audit_record(plan, archive))
    report["editions"] = records
    (output / checksum_name).write_text("".join(f"{record['sha256']}  {record['assetName']}\n" for record in records), encoding="ascii", newline="\n")
    (output / audit_name).write_bytes(json_bytes(report))
    print(json.dumps({"mode": "build", "checksumFile": checksum_name, "auditFile": audit_name,
                      "editions": [{key: value for key, value in record.items() if key != "files"} for record in records]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (PackagingError, OSError, ValueError) as error:
        print(f"Packaging failed: {error}", file=sys.stderr)
        raise SystemExit(1)
