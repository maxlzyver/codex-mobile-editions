# Third-party components — Windows 11 专用版 V1.2.0

Application: Codex 移动助手 · Windows 11 专用版, version 1.2.0.
Author: maxlzyver. Repository: https://github.com/maxlzyver/codex-mobile-editions.
Edition directory: editions/windows11. Portable archive: codex-mobile-windows11-1.2.0-x64.zip.

This is an independent companion application, not an official OpenAI client.
The application code is distributed under the MIT license in LICENSE.
The user's Codex executable and login are discovered locally and are not
included in the release archive. No compatibility claim for a third-party
Codex build is implied by this edition's Windows platform target.

| Component | Version | License | Source / bundled notice |
| --- | --- | --- | --- |
| Node.js, Windows x64 | 24.19.0 | MIT with included dependency notices | https://nodejs.org/dist/v24.19.0/ ; runtime/LICENSE |
| cloudflared, Windows x64 | 2026.10.0 | Apache-2.0 | https://github.com/cloudflare/cloudflared ; vendor/cloudflared-LICENSE.txt |
| qrcode-generator | 1.4.4 | MIT | https://www.npmjs.com/package/qrcode-generator/v/1.4.4 ; vendor/qrcode-LICENSE.txt |
| marked | 18.1.1 | MIT | https://github.com/markedjs/marked ; public/vendor/marked-LICENSE.txt |
| KaTeX | 0.19.0 | MIT | https://github.com/KaTeX/KaTeX ; public/vendor/katex-LICENSE.txt |

Node.js was verified against the official SHASUMS256.txt when preparing the
runtime. cloudflared is verified against the SHA256 digest in its official
GitHub release metadata. Its component metadata is kept beside the binary.
qrcode-generator was fetched from the npm registry and checked against the
registry archive checksum; its original copyright header remains in the code.
These upstream component release sources are separate from this application's
update channel: only maxlzyver/codex-mobile-editions, main branch,
editions/windows11/update.json. Application updates do not fall back to legacy Releases.

No login tokens, device pairings, task history, project files, or development
screenshots belong in the distributable archive or public repository. The
.runtime directory is private local state created on the destination computer.
Use the clean packaging workflow at repository-root tools/package-editions.py.
