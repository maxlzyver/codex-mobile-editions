# Third-party components

This independent community application is not an official OpenAI client. Application source is MIT licensed (LICENSE). Codex and account credentials are not included.

| Component | Version | License | Source / bundled notice |
| --- | --- | --- | --- |
| Node.js, macOS arm64 and x64 | 24.19.0 | MIT and bundled dependency notices | https://nodejs.org/dist/v24.19.0/ ; runtime/darwin-arm64/LICENSE, runtime/darwin-x64/LICENSE |
| cloudflared, macOS arm64 and amd64 | 2026.10.0 | Apache-2.0 | https://github.com/cloudflare/cloudflared ; vendor/cloudflared-LICENSE.txt |
| qrcode-generator | 1.4.4 | MIT | https://www.npmjs.com/package/qrcode-generator/v/1.4.4 ; vendor/qrcode-LICENSE.txt |

Node archives were checked against official SHASUMS256.txt. Cloudflared archives were checked against SHA256 digests in official GitHub release metadata; archive and extracted-binary hashes are recorded next to each binary. QR code library retains its original copyright and license.

Both runtime architectures are supplied in the complete installation ZIP. They are intentionally absent from the lightweight source/update repository and preserved during ordinary folder updates. No login tokens, device pairings, task history, project files or development screenshots are included in distributable archives.
