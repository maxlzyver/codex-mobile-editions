import { readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(new URL('../edition.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
if (profile.id !== 'windows10' || !/^\d+\.\d+\.\d+$/.test(profile.version) || profile.repository !== 'maxlzyver/codex-mobile-editions' || profile.updatePath !== 'editions/windows10') {
  throw new Error('专用版 edition.json 不匹配或已损坏，请重新完整解压本平台程序包。');
}
export const EDITION_INFO = Object.freeze(profile);
export const APP_INFO = Object.freeze({
  name: 'Codex 移动助手 · ' + profile.label,
  version: profile.version,
  author: 'maxlzyver',
  repository: 'https://github.com/' + profile.repository,
  feedbackEmail: 'lzyuan666666@gmail.com',
  edition: profile.id,
  editionId: profile.id,
  editionLabel: profile.label,
  platform: profile.platform,
  repositoryName: profile.repository,
  updatePath: profile.updatePath,
  assetName: profile.assetName,
});
