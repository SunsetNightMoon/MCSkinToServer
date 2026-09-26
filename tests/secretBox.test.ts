import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SecretBox, MASTER_SECRET_ENV } from '../src/util/secretBox.js';
import { AppError } from '../src/errors.js';

/**
 * 站点设置敏感值加密（P5）。
 *
 * 重点不在「能加能解」，而在三个失败形态必须被明确处理：
 * 主密钥过短要拒绝、换过密钥要报错（不能静默返回空口令）、
 * 加密前的历史明文要能继续读（否则升级一次 SMTP 就废了）。
 */

const SECRET = 'this-is-a-test-master-secret';

test('secretBox: 加解密往返（含中文与特殊字符）', () => {
  const box = new SecretBox(SECRET);
  const plain = '授权码 abcd-1234 !@#$ 中文';
  const cipher = box.encrypt(plain);

  assert.ok(cipher.startsWith('enc:v1:'), '密文必须带版本前缀');
  assert.notEqual(cipher, plain);
  assert.ok(!cipher.includes(plain), '密文里不得残留明文片段');
  assert.equal(box.decrypt(cipher), plain);
});

test('secretBox: 同一明文两次加密得到不同密文（随机 IV）', () => {
  const box = new SecretBox(SECRET);
  assert.notEqual(box.encrypt('same'), box.encrypt('same'));
});

test('secretBox: 主密钥不一致时抛错而不是返回空串', () => {
  const cipher = new SecretBox(SECRET).encrypt('secret-pass');
  const other = new SecretBox('another-master-secret-value');
  assert.throws(
    () => other.decrypt(cipher),
    (err: unknown) => err instanceof AppError && err.code === 'CONFIG_ERROR',
  );
});

test('secretBox: 密文被篡改则认证失败', () => {
  const box = new SecretBox(SECRET);
  const cipher = box.encrypt('secret-pass');
  const parts = cipher.slice('enc:v1:'.length).split(':');
  assert.equal(parts.length, 3);
  const iv = parts[0]!;
  const tag = parts[1]!;
  const ct = parts[2]!;

  /**
   * 篡改位置必须选**段首**，不能选段尾。
   *
   * 尾字符的坑：base64 末位字符里有若干比特只是补位（凑不满一个字节），
   * 这些比特不参与解码。改动它们得到的密文字节与原文**完全相同**，
   * GCM 自然验签通过 —— 表现为「这条断言偶尔不过」，约 1/16 命中率。
   * 段首字符的第一个字节则必定参与，篡改必然被发现。
   */
  const flip = (s: string): string =>
    (s.charAt(0) === 'A' ? 'B' : 'A') + s.slice(1);

  const tamperedCt = `${'enc:v1:'}${iv}:${tag}:${flip(ct)}`;
  assert.notEqual(tamperedCt, cipher);
  assert.throws(() => box.decrypt(tamperedCt), /解密失败/, '改动密文必须验签失败');

  // 认证标签是 GCM 的完整性凭据，改它同样必须失败
  const tamperedTag = `${'enc:v1:'}${iv}:${flip(tag)}:${ct}`;
  assert.notEqual(tamperedTag, cipher);
  assert.throws(() => box.decrypt(tamperedTag), /解密失败/, '改动认证标签必须验签失败');

  // IV 被换掉后也解不出原文（换个 IV 等于换一把 nonce）
  const tamperedIv = `${'enc:v1:'}${flip(iv)}:${tag}:${ct}`;
  assert.throws(() => box.decrypt(tamperedIv), /解密失败/);
});

test('secretBox: 未加密的历史明文原样返回（升级容错）', () => {
  const box = new SecretBox(SECRET);
  assert.equal(box.decrypt('plain-old-password'), 'plain-old-password');
});

test('secretBox: 主密钥过短直接拒绝', () => {
  assert.throws(() => new SecretBox('short'), AppError);
});

test('secretBox: fromEnv 未设置返回 null，设置后可用', () => {
  assert.equal(SecretBox.fromEnv({}), null);
  assert.equal(SecretBox.fromEnv({ [MASTER_SECRET_ENV]: '' }), null);

  const box = SecretBox.fromEnv({ [MASTER_SECRET_ENV]: SECRET });
  assert.ok(box);
  assert.equal(box.decrypt(box.encrypt('x')), 'x');
});

test('secretBox: encryptIfNeeded 不会二次加密', () => {
  const box = new SecretBox(SECRET);
  const once = box.encryptIfNeeded('pass');
  const twice = box.encryptIfNeeded(once);
  assert.equal(twice, once);
  assert.equal(box.decrypt(twice), 'pass');
});

test('secretBox: 密文格式损坏时报格式错误', () => {
  const box = new SecretBox(SECRET);
  assert.throws(() => box.decrypt('enc:v1:only-two:parts'), /格式不正确/);
});
