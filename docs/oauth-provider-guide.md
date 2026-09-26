# 第三方登录接入指南（预留端口）

> 本文档面向**自部署者 / 二次开发者**。
> MCSTS 本身**不内置**任何第三方登录，只提供接线口。

---

## 1. 本项目提供什么、不提供什么

**提供：**

| 东西 | 位置 |
| --- | --- |
| provider 契约接口 | `src/account/oauth/types.ts` → `OAuthProvider` |
| 注册表（注册 / 注销 / 查询） | `src/account/oauth/registry.ts` |
| 前端契约端点（开关对象） | `GET /api/auth/oauth/providers` |
| 通用列表端点 | `GET /api/oauth/providers` |
| 入口 / 回调的占位路由 | `GET /api/auth/oauth/:providerId`、`.../:providerId/callback` |
| 前端登录页 / 注册页的「第三方登录」小格子 | `web/src/pages/Auth/Login.tsx`、`Register.tsx`（已存在，默认不渲染） |

**不提供（刻意的，不是"暂未实现"）：**

1. **任何真实 provider 的实现** —— 没有 GitHub / Microsoft / Bilibili / QQ 的
   客户端 ID、密钥、现成代码。接入方自己申请、自己保管、自己负责合规。
2. **回调落地** —— 不做 provider 账号 ↔ 本地账号的绑定。原因见 §5。
3. **电话 / 短信验证** —— 见 §2，这是硬约束。

---

## 2. 硬约束：不做电话 / 短信验证

本项目**不提供、也不会提供**手机号与短信验证码能力：

- `OAuthAccount`（`src/account/oauth/types.ts`）**没有 `phone` 字段**，只有
  `email` / `emailVerified`。
- 不存在任何短信发送端点、短信模板、验证码表。
- `GET /api/auth/oauth/:providerId` 与回调路由不存在手机号参数。

理由：手机号是可被用于社工与骚扰的强身份标识，保管它意味着承担
「泄露了要赔谁」的责任。本项目不愿意、也没能力替用户的手机号负责。
**如果你接入的 provider 只返回手机号而不返回邮箱，请改用其它 provider。**

---

## 3. 默认行为（什么都没做的时候）

```
GET /api/auth/oauth/providers
→ 200 { "github": false, "microsoft": false }
```

`Login.tsx` / `Register.tsx` 里：

```tsx
{(oauthProviders.github || oauthProviders.microsoft) && ( /* 整块小格子 */ )}
```

两个都是 `false` → **整块第三方登录 UI 不渲染**。这是纯 MCSTS 部署的常态，
也是生产环境的推荐状态（少一个攻击面）。

> 前端读的是**布尔开关**而不是数组，这是沿用旧版界面的历史形状。
> 只有 `github` / `microsoft` 两个键会被渲染。
> 其它 id（如 `bilibili`）即使注册了也不会出现在界面上，
> 除非你自己改前端 —— 见 §6。

---

## 4. 最小接入步骤

### 4.1 实现 `OAuthProvider`

新建一个文件，例如 `src/account/oauth/providers/myGithub.ts`：

```ts
import type {
  OAuthAccount,
  OAuthAuthorizeInput,
  OAuthExchangeInput,
  OAuthProvider,
} from '../types.js';

export function createMyGithubProvider(env: {
  clientId: string;
  clientSecret: string;
}): OAuthProvider {
  return {
    id: 'github',          // 想出现在前端小格子上，id 必须是 github / microsoft
    displayName: 'GitHub',
    // 凭据没配齐就置 false：前端不显示按钮，而不是显示一个点了必报错的按钮
    enabled: Boolean(env.clientId && env.clientSecret),

    authorizeUrl(input: OAuthAuthorizeInput): string {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', env.clientId);
      url.searchParams.set('redirect_uri', input.redirectUri);
      url.searchParams.set('scope', 'read:user user:email');
      // state 必须原样带上；回调时必须比对
      url.searchParams.set('state', input.state);
      return url.toString();
    },

    async exchangeCode(input: OAuthExchangeInput): Promise<OAuthAccount> {
      // 1) code → access_token（POST https://github.com/login/oauth/access_token）
      // 2) access_token → /user 取 id（当作 subject）
      // 3) access_token → /user/emails 取 primary 且 verified 的邮箱
      //    ⚠ 只有 verified 才能把 emailVerified 置 true
      throw new Error('按你的 provider 实现');
    },
  };
}
```

### 4.2 在启动时注册

在 `src/server/main.ts` 装配段（或你自己的启动脚本）里：

```ts
import { registerOAuthProvider } from '../account/oauth/registry.js';

registerOAuthProvider(
  createMyGithubProvider({
    clientId: process.env['GITHUB_CLIENT_ID'] ?? '',
    clientSecret: process.env['GITHUB_CLIENT_SECRET'] ?? '',
  }),
);
```

注册顺序无所谓：注册表是模块级单例，「先注册后建 app」与「先建 app 后注册」
都生效（读取发生在请求时）。

### 4.3 挂载真实入口与回调

当前 `GET /api/auth/oauth/github` 会返回 **501**，提示你来实现这一段。
你需要自己加两条路由：

- `GET /api/auth/oauth/:providerId` —— 生成随机 `state` → 存入会话/缓存
  （带 TTL，例如 10 分钟）→ 302 跳到 `provider.authorizeUrl({ redirectUri, state })`
- `GET /api/auth/oauth/:providerId/callback` —— 校验 `state`（比对后立即删除）
  → 调 `provider.exchangeCode({ code, redirectUri, state })`
  → 绑定/创建本地账号 → 签发本地 token

**不建议**改动本仓库的 `createOAuthRouter`，而是新建一个你自己的 router
挂在同一前缀下（Express 会按注册顺序匹配）：

```ts
app.use(createMyOAuthRouter({ /* … */ }));   // 你的实现，放在 createOAuthRouter 之前
app.use(createOAuthRouter({ /* … */ }));     // 兜底：未实现的 provider 仍然 501
```

---

## 5. 为什么回调不在本仓库里实现

绑定 provider 身份需要一张**身份绑定表**，而它的形状取决于你的账号模型：

```sql
-- 示意，不是本仓库的迁移
CREATE TABLE oauth_identities (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id    TEXT NOT NULL,
  subject        TEXT NOT NULL,
  email          TEXT,          -- provider 返回的邮箱（仅存档，不作登录凭据）
  linked_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (provider_id, subject)  -- 同一 provider 身份只能绑一个本地账号
);
```

这段代码是整个认证链路里**风险最高**的一段：`state` 校验、换码、邮箱可信度判定、
已有账号的合并策略、并发绑定竞态（同一 subject 同时被两个请求绑定 → 唯一约束冲突要
转成可读错误）。**半成品实现比没有实现更危险** —— 部署者会以为「已经能用」，
而实际上少了 `state` 校验或邮箱验证判定，可被伪造登录。

因此本项目只留端口，不留陷阱。

### 实现时的检查清单

- [ ] `state` 随机且一次性，回调后**立即删除**，比对不通过直接拒绝
- [ ] `redirect_uri` 在发起与换码两处**完全一致**
- [ ] `emailVerified === false` 时**不要**把 provider 邮箱写成本地账号的已验证邮箱
- [ ] `subject` 用 provider 的**稳定 ID**（GitHub 是数字 id、Microsoft 是 `oid`），
      不要用用户名/邮箱
- [ ] 同一 `subject` 只会绑一个本地账号；撞唯一约束时给可读错误而不是 500
- [ ] 不把 `client_secret`、`access_token` 写进日志或回显给前端
- [ ] 不存手机号，不接短信（§2）

---

## 6. 让更多 provider 出现在界面上

前端目前只渲染 `github` / `microsoft` 两个键。要加 Bilibili / QQ 等：

**方案 A（推荐，改动最小）：** 只做后端。第三方登录对你可能只是「给用户多一个入口」，
而入口在登录页上多一个按钮，收益有限、维护成本实打实。先不做。

**方案 B：** 改 `Login.tsx` / `Register.tsx` 的渲染分支，读 `GET /api/oauth/providers`
返回的数组，按数组动态渲染：

```tsx
const res = await fetch('/api/oauth/providers');
const { providers } = await res.json();   // [{ id: 'github', displayName: 'GitHub' }]
```

`/api/auth/oauth/providers`（布尔形状）保留不动，因为它是旧前端的契约。

---

## 7. 相关文件索引

| 路径 | 作用 |
| --- | --- |
| `src/account/oauth/types.ts` | `OAuthProvider` 契约、`OAuthAccount`（无 phone） |
| `src/account/oauth/registry.ts` | 注册表、`advertiseProviderFlags()`、`summarizeOAuthProviders()` |
| `src/server/routes/oauth.ts` | 4 个 HTTP 端点；入口/回调返回 501 |
| `src/server/app.ts` | `oauthProviders` 可选依赖 + `createOAuthRouter` 挂载点 |
| `tests/oauth.test.ts` | 端点与注册表的行为测试 |
| `web/src/utils/apiCompat.ts` | 旧版路径翻译层；`/api/auth/oauth/providers` **透传**给后端 |
| `web/src/pages/Auth/Login.tsx` | 前端小格子（读 `github` / `microsoft` 布尔） |
| `web/src/pages/Auth/Register.tsx` | 同上（注册页也有一份） |

> ⚠️ 改动前请注意：`Login.tsx` / `Register.tsx` 里的 `fetch` 是
> `import { compatFetch as fetch } from '../../utils/apiCompat'`，
> 请求会先经过 `web/src/utils/apiCompat.ts` 的翻译层。
> 这个开关端点**已改为透传**（曾经写死 `false`，那会让宿主注册了 provider
> 也永远看不到小格子）。如果你再引入新的第三方登录端点，记得在翻译层里放行，
> 否则前端请求到不了后端。

### 一个不能用但还躺在那里的文件

`web/src/pages/Auth/OAuthCallback.tsx` 是 plan3（旧项目）的遗留物：

- **没有被任何路由引用**（`App.tsx` 里只有一句注释提到 `/oauth-success`），
  属于死代码，不影响构建与运行。
- 它请求的是 `/api/auth/me`，**MCSTS 没有这个端点**（正确的是 `/api/me`）；
  它还读 `?token=` / `?new_user=` 查询参数，这两者在 MCSTS 的登录流程里都不存在。
- `docs/route-inventory.md` 里能查到旧项目的 `oauth_accounts` 表与
  `/api/auth/oauth/:provider` 路由 —— 这就是它的来历。

**结论：不要把它接到任何路由上。** 你要做回调，请按 §4.3 自己写页面与路由；
照抄这个文件会得到一条「永远拿不到 token」的登录链路。
（清掉它是安全的一处整理，但本项目保留旧版资产，未主动删除。）
