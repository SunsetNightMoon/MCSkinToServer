import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import type { CachePort, RateLimiterPort } from '../cache/types.js';

/**
 * 机器回调的签名校验（插件的 `hooks` 入口用它）。
 *
 * ## 为什么这是功能正确性而不是安全剧场
 *
 * 以基岩版绑定为例：一条绑定要**两条互相独立的证据**才成立 ——
 * 玩家在自己账号里点出来的**一次性码**（证明本人授权），加上由 Java 服务器实测拿到的
 * **XUID**（证明那个基岩身份此刻确实登在里面）。HMAC 证明的就是后半句「这条请求真的来自
 * 配了同一把密钥的那台服务器」，而不是某个猜到路径的人自报 XUID。
 * 少任何一条都不该绑成，所以这里既不能省签名，也不能省码。
 *
 * ## 签名串
 *
 * `HMAC-SHA256(secret, ts + "\n" + nonce + "\n" + METHOD + "\n" + path + "\n" + sha256hex(body))`
 * 十六进制小写。头三个：`X-MCSTS-Timestamp` / `X-MCSTS-Nonce` / `X-MCSTS-Signature`。
 *
 * 时间窗 ±120s（容忍服务器与站点机钟差），nonce 在窗口内不可重复（防重放）。
 * nonce 存储走 CachePort：Redis 可用时多实例共享，未配 Redis 时降级为进程内存 ——
 * 那种形态下重放防护只在单实例内成立，属于「可选依赖关闭时功能降级但不失效」的既有口径。
 */

export const TIMESTAMP_HEADER = 'X-MCSTS-Timestamp';
export const NONCE_HEADER = 'X-MCSTS-Nonce';
export const SIGNATURE_HEADER = 'X-MCSTS-Signature';

const WINDOW_MS = 120_000;
const NONCE_TTL_MS = WINDOW_MS * 2;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_header' | 'bad_timestamp' | 'bad_signature' | 'replayed' };

export function canonicalString(input: {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body: unknown;
}): string {
  const bodyText =
    input.body === undefined || input.body === null
      ? ''
      : typeof input.body === 'string'
        ? input.body
        : JSON.stringify(input.body);
  return [
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    createHash('sha256').update(bodyText, 'utf8').digest('hex'),
  ].join('\n');
}

export function sign(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export class PluginHookAuthenticator {
  /**
   * 未配 Redis 时的进程内 nonce 表。
   *
   * 不能因为没缓存就跳过防重放 —— 那等于「可选依赖关掉之后，安全属性静默消失」。
   * 降级成进程内存的代价是重启即清空、多实例各记各的，与限流层的降级口径一致。
   */
  private readonly localNonces = new Map<string, number>();

  constructor(
    private readonly cache?: CachePort,
    private readonly rateLimiter?: RateLimiterPort,
  ) {}

  /**
   * 校验一条 hooks 请求。
   *
   * `path` 必须是**挂载后的完整路径**，否则攻击者可以拿一个合法签名换到别的路径上重放。
   */
  async verify(input: {
    secret: string | null;
    timestamp: string | undefined;
    nonce: string | undefined;
    signature: string | undefined;
    method: string;
    path: string;
    body: unknown;
  }): Promise<VerifyResult> {
    if (!input.secret) return { ok: false, reason: 'missing_header' };
    const { timestamp, nonce, signature } = input;
    if (!timestamp || !nonce || !signature) return { ok: false, reason: 'missing_header' };
    if (!NONCE_PATTERN.test(nonce)) return { ok: false, reason: 'missing_header' };

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WINDOW_MS) {
      return { ok: false, reason: 'bad_timestamp' };
    }

    const expected = sign(
      canonicalString({
        timestamp,
        nonce,
        method: input.method,
        path: input.path,
        body: input.body,
      }),
      input.secret,
    );
    if (!safeEqualHex(expected, signature.toLowerCase())) {
      return { ok: false, reason: 'bad_signature' };
    }

    // 先占位再判重：并发重放两条同 nonce 时，两条都可能读到「没见过」，
    // 而 set 是后写覆盖 —— 所以这里只能算「尽力防重放」，不是严格互斥。
    // 要严格互斥得靠 Redis SETNX；当前威胁模型下（重放一条绑定请求的收益是「把已经绑过的
    // 同一对关系再绑一次」，幂等无害）够用，且这一点必须写在脸上而不是含糊成「防重放」。
    const replayKey = `plugin:nonce:${input.path}:${nonce}`;
    if (this.cache) {
      if (await this.cache.get<string>(replayKey)) return { ok: false, reason: 'replayed' };
      await this.cache.set(replayKey, '1', NONCE_TTL_MS);
      return { ok: true };
    }
    const nowMs = Date.now();
    for (const [key, expires] of this.localNonces) {
      if (expires <= nowMs) this.localNonces.delete(key);
    }
    if (this.localNonces.has(replayKey)) return { ok: false, reason: 'replayed' };
    this.localNonces.set(replayKey, nowMs + NONCE_TTL_MS);
    return { ok: true };
  }

  /**
   * hooks 端口的限流按「插件 + 来源 IP」分桶。
   *
   * 不按账号分桶是因为这类调用根本没有账号；不限量则意味着泄露路径后可以无限试探签名。
   */
  async consumeRateLimit(
    pluginId: string,
    ip: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; resetAfterMs: number }> {
    if (!this.rateLimiter) return { allowed: true, resetAfterMs: 0 };
    const result = await this.rateLimiter.consume(
      `plugin:hook:${pluginId}:${ip}`,
      limit,
      windowMs,
    );
    return { allowed: result.allowed, resetAfterMs: result.resetAfterMs };
  }
}

/** 给超管生成服务器侧密钥用（面板上「复制给 Java 服配置文件」的那一串） */
export function generateHookSecret(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}
