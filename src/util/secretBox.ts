import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { AppError } from '../errors.js';

/**
 * 站点设置里敏感值的对称加密（P5）。
 *
 * 背景：`system_settings.value` 是明文 JSON 列，而 SMTP 授权码这类值一旦落库
 * 就等于裸奔 —— 数据库备份、只读副本、误开的日志导出都会把它带出去。
 * 因此 `SMTP_PASS` 落库前先在这里加密，密钥来自环境变量 `MCSTS_SECRET`
 * （与站点设置分离：拿到数据库的人拿不到主密钥）。
 *
 * 算法选择 AES-256-GCM 而非 CBC：
 * - GCM 自带认证标签，密文被篡改会在解密时直接失败，不需要额外 HMAC 组合
 * - 12 字节随机 IV（96 bit 是 GCM 的推荐长度，避免额外的一次 GHASH 派生）
 *
 * 密文格式：`enc:v1:<iv:b64>:<tag:b64>:<ciphertext:b64>`
 * 带版本前缀是为了将来换算法时能识别并迁移旧值，而不是靠猜。
 *
 * **容错读取**：解密时遇到不带前缀的值（加密功能上线前写入的历史明文）原样返回，
 * 使老库升级后 SMTP 仍可用；只有格式正确但认证失败（主密钥被换过）才抛错。
 */

const VERSION_PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const MIN_MASTER_SECRET_LENGTH = 16;

/** 环境变量名：主密钥。单独一个变量而不是复用 RSA 私钥，便于轮换与最小暴露 */
export const MASTER_SECRET_ENV = 'MCSTS_SECRET';

export class SecretBox {
  private readonly key: Buffer;

  constructor(masterSecret: string) {
    if (typeof masterSecret !== 'string' || masterSecret.trim().length < MIN_MASTER_SECRET_LENGTH) {
      throw new AppError(
        'CONFIG_ERROR',
        `${MASTER_SECRET_ENV} 至少需要 ${MIN_MASTER_SECRET_LENGTH} 个字符`,
      );
    }
    // 任意长度的口令 → 定长密钥；主密钥不需要记忆，用 KDF 仅为消除长度差异
    this.key = createHash('sha256').update(masterSecret, 'utf8').digest();
  }

  /**
   * 从环境变量构造；未设置或过短时返回 null（调用方决定是降级还是拒绝启动）。
   * 不在这里直接抛错：测试与本地开发未配置主密钥时仍应能跑通非邮件链路。
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox | null {
    const raw = env[MASTER_SECRET_ENV];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    return new SecretBox(raw);
  }

  /** 判断一个值是否为本模块产出的密文 */
  static isEncrypted(value: unknown): boolean {
    return typeof value === 'string' && value.startsWith(VERSION_PREFIX);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return (
      VERSION_PREFIX +
      [iv, tag, ciphertext].map((b) => b.toString('base64')).join(':')
    );
  }

  /** 解密；未加密的历史明文原样返回（见文件头「容错读取」） */
  decrypt(value: string): string {
    if (!SecretBox.isEncrypted(value)) return value;

    const parts = value.slice(VERSION_PREFIX.length).split(':');
    if (parts.length !== 3) {
      throw new AppError('CONFIG_ERROR', '密文格式不正确（应为 iv:tag:ct 三段）');
    }
    // 段数已校验，这里用 ! 消解 noUncheckedIndexedAccess；长度校验紧随其后
    const iv = Buffer.from(parts[0]!, 'base64');
    const tag = Buffer.from(parts[1]!, 'base64');
    const ciphertext = Buffer.from(parts[2]!, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) {
      throw new AppError('CONFIG_ERROR', '密文格式不正确（IV 或认证标签长度异常）');
    }

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch (err) {
      // 认证失败只有两种可能：密文被改过，或主密钥变了。
      // 两种情况都无法自行恢复，必须让运维看见 —— 静默降级成空密码只会让人以为「SMTP 坏了」。
      throw new AppError(
        'CONFIG_ERROR',
        `密文解密失败：${MASTER_SECRET_ENV} 是否与加密时不一致？`,
        { cause: err },
      );
    }
  }

  /** 便于调用方按需加密：已加密的值不重复套娃 */
  encryptIfNeeded(value: string): string {
    return SecretBox.isEncrypted(value) ? value : this.encrypt(value);
  }
}

/** 密钥长度常量，供测试与文档引用 */
export const SECRET_KEY_BYTES = KEY_BYTES;
