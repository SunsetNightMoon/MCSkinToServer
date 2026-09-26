import { Router } from 'express';
import type { OAuthProvider } from '../../account/oauth/types.js';
import {
  advertiseProviderFlags,
  listOAuthProviders,
  summarizeOAuthProviders,
} from '../../account/oauth/registry.js';
import { AppError } from '../../errors.js';

/**
 * 第三方登录**预留端口**的 HTTP 适配层（P5 批4-F）。
 *
 * - GET /api/auth/oauth/providers          开关对象（旧版形状，前端登录/注册页用）
 * - GET /api/oauth/providers               通用列表（不含凭据）
 * - GET /api/auth/oauth/:providerId        入口，未实现时 501
 * - GET /api/auth/oauth/:providerId/callback  回调，未实现时 501
 *
 * ## 为什么入口与回调是 501 而不是真正的跳转
 *
 * 把 provider 账号映射到本地账号需要一张「本地账号 ↔ provider 身份」绑定表
 * （同一 provider 的同一 subject 只能绑一个本地账号，反过来一个本地账号可以绑多个
 * provider）。这张表的形状取决于接入方的账号模型，且是整个认证链路里风险最高的一段
 * （state 校验、换码、邮箱可信度判定、并发绑定竞态）。本项目明确不做第三方登录，
 * 因此**不落地半成品实现** —— 半成的 OAuth 回调比没有更危险：
 * 它会让部署者以为「已经能用」，而实际上缺少 state 校验或邮箱验证判定，可被伪造登录。
 *
 * 501 的语义在这里是有用的：404 会让部署者以为地址填错，501 明说
 * 「接线口在这里，实现要你自己写」，并指向 `docs/oauth-provider-guide.md`。
 * 未注册的 provider 才返回 404（确实不存在这个入口）。
 *
 * ## 绝不出现的东西
 *
 * 本文件、以及它引用的所有类型，都**不存在手机号 / 短信验证码**相关的字段与端点。
 * 这是项目的硬约束，不是「暂未实现」。
 */

export interface OAuthRouteDependencies {
  /**
   * provider 列表来源。缺省读模块级注册表（`registerOAuthProvider` 注册）。
   * 测试可注入固定列表，完全不必碰全局状态。
   */
  providers?: () => OAuthProvider[];
}

const GUIDE = 'docs/oauth-provider-guide.md';

export function createOAuthRouter(deps: OAuthRouteDependencies = {}): Router {
  const router = Router();

  /** 已启用的 provider（禁用与未注册一律不广告） */
  const enabled = (): OAuthProvider[] =>
    (deps.providers ? deps.providers() : listOAuthProviders()).filter(
      (p) => p.enabled,
    );

  /**
   * 前端契约端点。
   *
   * 响应形状刻意保持不变 —— `{ github: false, microsoft: false }`。
   * `web/src/pages/Auth/Login.tsx` 与 `Register.tsx` 读的就是这两个键，
   * 且只有两者之一为 true 时才渲染整块第三方登录小格子。
   * 沿用旧版界面是硬约束，因此这里适配前端，而不是改前端来适配这里。
   *
   * 无 provider 时返回全 false：前端小格子整体不渲染，与「本项目不做第三方登录」
   * 的默认状态一致。
   */
  router.get('/api/auth/oauth/providers', (_req, res) => {
    // provider 开关可能被运行期调整，不能让中间层缓存成旧的 true ——
    // 那会让前端显示一个点了必然报错的按钮
    res.setHeader('Cache-Control', 'no-store');
    res.json(advertiseProviderFlags(enabled()));
  });

  /** 通用列表：给将来的动态渲染与接入方自检用；只暴露公开信息 */
  router.get('/api/oauth/providers', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ providers: summarizeOAuthProviders(enabled()) });
  });

  /** 入口与回调共用的处理器：注册过就 501(指向文档)，没注册过就 404 */
  const portHandler = (suffix: string) => {
    return (req: import('express').Request, _res: import('express').Response) => {
      const providerId = String(req.params['providerId'] ?? '');
      const known = enabled().some((p) => p.id === providerId);
      if (!known) {
        throw new AppError('NOT_FOUND', `第三方登录方式 ${providerId} 未启用`);
      }
      throw new AppError(
        'NOT_IMPLEMENTED',
        `第三方登录 ${providerId}${suffix} 为预留端口，本项目不内置实现。` +
          `请按 ${GUIDE} 实现 OAuthProvider 并自行挂载入口与回调路由。`,
      );
    };
  };

  // 顺序要紧：`/providers` 必须先注册，否则会被 `:providerId` 抢先命中
  router.get('/api/auth/oauth/:providerId/callback', portHandler(' 回调'));
  router.get('/api/auth/oauth/:providerId', portHandler(' 入口'));

  return router;
}
