import { readFileSync } from 'node:fs';
const edition = JSON.parse(readFileSync(new URL('../edition.json', import.meta.url), 'utf8'));
export const APP_INFO = Object.freeze({
  name: `Codex 移动助手 · ${edition.label}`,
  version: edition.version,
  author: 'maxlzyver',
  repository: `https://github.com/${edition.repository}`,
  feedbackEmail: 'lzyuan666666@gmail.com',
  edition: edition.id, editionId: edition.id, label: edition.label,
  platform: edition.platform, updatePath: edition.updatePath, assetName: edition.assetName,
});
