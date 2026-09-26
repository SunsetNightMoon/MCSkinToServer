import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Yggdrasil RSA 密钥对管理。
 * - 签名算法与 Mojang 一致：SHA1withRSA（PKCS#1 v1.5，确定性签名）
 * - 首次启动自动生成 2048 位密钥并落盘（写密钥文件 ≠ 运行时改 .env，蓝图 §5.1 不冲突）
 * - 公钥从私钥推导（单一事实来源）
 */

export interface RsaKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function loadOrCreateKeyPair(privateKeyPath: string): RsaKeyPair {
  if (existsSync(privateKeyPath)) {
    const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
    const publicKeyPem = createPublicKey(privateKeyPem).export({
      type: 'spki',
      format: 'pem',
    });
    return { privateKeyPem, publicKeyPem: publicKeyPem.toString() };
  }

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  mkdirSync(dirname(privateKeyPath), { recursive: true });
  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/** SPKI PEM → DER 的 base64（authlib-injector metadata 的 signaturePublickey 字段） */
export function publicKeyDerBase64(publicKeyPem: string): string {
  return publicKeyPem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
}
