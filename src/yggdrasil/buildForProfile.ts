import type { AssetUrlResolver } from '../storage/assetUrl.js';
import type { ProfileTextureState } from '../repositories/profileRepository.js';
import type {
  BuildTexturePropertyInput,
  TexturePropertyDto,
} from './textures.js';
import { TextureProfileBuilder } from './textures.js';

/**
 * ProfileRepository 纹理状态 → builder 输入 的组合入口。
 * Yggdrasil hasJoined / profile/:uuid / Web 3D 预览共用这一条链路：
 *   profile -> active assets（rejected 已在仓储层排除） -> AssetUrlResolver -> textures property
 */
export function buildForProfile(
  builder: TextureProfileBuilder,
  state: ProfileTextureState,
  resolver: AssetUrlResolver,
  options: { unsigned?: boolean; now?: Date } = {},
): TexturePropertyDto {
  const input: BuildTexturePropertyInput = {
    profileId: state.profileId,
    profileName: state.profileName,
    skin: state.skin
      ? {
          url: resolver.forBlob(state.skin),
          modelType: state.skin.modelType,
        }
      : null,
    cape: state.cape ? { url: resolver.forBlob(state.cape) } : null,
    unsigned: options.unsigned,
    now: options.now,
  };
  return builder.buildTextureProperty(input);
}
