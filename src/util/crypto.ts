import { createHash } from 'node:crypto';

/** sha256 的小写 hex，用于 token hash 与 blob 内容寻址 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
