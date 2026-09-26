/**
 * 生成 Yggdrasil RSA 签名固定测试向量（蓝图 P0：RSA 签名必须有固定测试向量）。
 *
 * PKCS#1 v1.5 签名是确定性的：相同输入 + 相同密钥 → 相同签名。
 * 因此 fixtures/yggdrasil-vector.json 中的 expectedValue / expectedSignature
 * 可以作为永久回归基准；只要本脚本产物不变，textures builder 的
 * JSON 序列化、Base64 编码和 RSA-SHA1 算法行为就被锁定。
 *
 * 运行：npm run gen:vector   （仅当有意修改序列化/签名行为时重新生成并审查 diff）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { sha256Hex } from '../src/util/crypto.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const NOW = '2026-09-23T00:00:00.000Z';
const skinHash = sha256Hex('mcsts-vector-skin');
const capeHash = sha256Hex('mcsts-vector-cape');

const input = {
  profileId: '12345678-90ab-cdef-1234-567890abcdef',
  profileName: 'Arona',
  skin: {
    url: `http://localhost:3000/uploads/blobs/${skinHash.slice(0, 2)}/${skinHash}.png`,
    modelType: 'slim' as const,
  },
  cape: {
    url: `http://localhost:3000/uploads/blobs/${capeHash.slice(0, 2)}/${capeHash}.png`,
  },
  unsigned: false,
  now: NOW,
};

const builder = new TextureProfileBuilder(privateKey);
const prop = builder.buildTextureProperty({
  ...input,
  now: new Date(NOW),
});
if (!prop.signature) {
  throw new Error('签名未生成');
}

const fixture = {
  _comment:
    'Yggdrasil textures property 固定测试向量；由 scripts/generate-yggdrasil-vector.ts 生成',
  privateKeyPem: privateKey,
  publicKeyPem: publicKey,
  input,
  expectedValue: prop.value,
  expectedSignature: prop.signature,
};

mkdirSync(resolve('tests/fixtures'), { recursive: true });
writeFileSync(
  resolve('tests/fixtures/yggdrasil-vector.json'),
  `${JSON.stringify(fixture, null, 2)}\n`,
  'utf8',
);
console.log('vector written: tests/fixtures/yggdrasil-vector.json');
console.log('value length:', prop.value.length, 'signature length:', prop.signature.length);
