import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { assertMac, codexCandidates, macNodePath } from '../lib/mac-launcher.mjs';
import { cloudflaredAsset, extractCloudflared } from '../lib/tunnel.mjs';
import { trustedUnixSocket } from '../lib/desktop-bridge.mjs';
function tar(name='cloudflared',type='0') { const header=Buffer.alloc(512),data=Buffer.from('test executable');header.write(name);header.write(data.length.toString(8).padStart(11,'0')+'\0',124);header.write(type,156);return gzipSync(Buffer.concat([header,data,Buffer.alloc(512-data.length),Buffer.alloc(1024)])); }
test('mac bootstrap selects bundled architecture and rejects other systems',()=>{
  assert.match(macNodePath('/root','arm64'),/darwin-arm64/);assert.match(macNodePath('/root','x64'),/darwin-x64/);assert.throws(()=>macNodePath('/root','ia32'));
  assert.doesNotThrow(()=>assertMac('darwin','23.0.0'));assert.throws(()=>assertMac('darwin','22.0.0'));assert.throws(()=>assertMac('win32','99.0.0'));
  assert.ok(codexCandidates({home:'/users/test',env:{PATH:''}}).includes('/Applications/Codex.app/Contents/Resources/codex'));
});
test('cloudflared official mac asset selection and safe single-file extraction',()=>{
  assert.equal(cloudflaredAsset('darwin','x64').asset,'cloudflared-darwin-amd64.tgz');assert.equal(cloudflaredAsset('darwin','arm64').binary,'cloudflared-darwin-arm64');
  assert.throws(()=>cloudflaredAsset('win32','x64'));assert.equal(extractCloudflared(tar()).toString(),'test executable');
  assert.throws(()=>extractCloudflared(tar('../escape')));assert.throws(()=>extractCloudflared(tar('cloudflared','2')));
});
test('Unix desktop discovery rejects untrusted path shapes before connecting',async()=>{
  await assert.rejects(trustedUnixSocket('/tmp/foreign.sock',{uid:123}),/无效/);
  await assert.rejects(trustedUnixSocket('codex-browser-use-00000000-0000-0000-0000-000000000000.sock',{uid:123}),/无效/);
});
