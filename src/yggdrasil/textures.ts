import { createSign } from 'node:crypto';
import { toShortUuid } from './uuid.js';

/**
 * TextureProfileBuilder（蓝图 §6.2）：全服务唯一的 textures property 构建器。
 * 替换 plan3 中 hasJoined 与 profile/:uuid 两处重复实现。
 *
 * 输入是纯 DTO（URL 已由 AssetUrlResolver 解析），输出是 textures property：
 *   payload JSON → base64(value) →（可选）RSA-SHA1 签名
 *
 * 字段顺序固定：timestamp, profileId, profileName, isPublic, textures —— 签名/测试向量依赖确定性序列化。
 */

export interface TextureUrlInput {
  url: string;
  /** 仅皮肤：slim 时输出 metadata.model；default/null 不输出 metadata */
  modelType?: 'default' | 'slim' | null;
}

export interface BuildTexturePropertyInput {
  /** 内部规范 UUID（带连字符）；输出自动转无连字符 */
  profileId: string;
  profileName: string;
  skin?: TextureUrlInput | null;
  cape?: TextureUrlInput | null;
  /** true 时省略 signature（Yggdrasil ?unsigned=true 语义） */
  unsigned?: boolean;
  /** 可注入时钟（确定性测试向量依赖） */
  now?: Date;
}

export interface TexturePropertyDto {
  name: 'textures';
  value: string;
  signature?: string;
}

export interface TexturePayload {
  timestamp: string;
  profileId: string;
  profileName: string;
  isPublic: boolean;
  textures: Record<string, { url: string; metadata?: { model: string } }>;
}

export class TextureProfileBuilder {
  /** privateKeyPem 为 null 时视为"无签名能力"，等效 unsigned */
  constructor(private readonly privateKeyPem: string | null) {}

  buildTextureProperty(input: BuildTexturePropertyInput): TexturePropertyDto {
    const textures: TexturePayload['textures'] = {};

    if (input.skin) {
      const entry: TexturePayload['textures'][string] = {
        url: input.skin.url,
      };
      if (input.skin.modelType === 'slim') {
        entry.metadata = { model: 'slim' };
      }
      textures['SKIN'] = entry;
    }
    if (input.cape) {
      textures['CAPE'] = { url: input.cape.url };
    }

    const payload: TexturePayload = {
      timestamp: (input.now ?? new Date()).getTime().toString(),
      profileId: toShortUuid(input.profileId),
      profileName: input.profileName,
      isPublic: true,
      textures,
    };

    const value = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64',
    );
    if (input.unsigned || !this.privateKeyPem) {
      return { name: 'textures', value };
    }

    const signature = createSign('RSA-SHA1')
      .update(value, 'utf8')
      .sign(this.privateKeyPem, 'base64');
    return { name: 'textures', value, signature };
  }
}
