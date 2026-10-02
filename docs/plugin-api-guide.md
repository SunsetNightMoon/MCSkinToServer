# MCSTS 插件开发指南

**简体中文** | 本文写给插件作者。它假设你**看不到 MCSTS 的源码** —— 如果你发现自己必须去猜核心实现才能把插件写下去，那是这份文档的缺陷，请反馈。

全文与具体业务无关：§0–§8 是框架契约与一个领域无关的最小例子；§9 是唯一被真机验过的官方插件案例（基岩身份绑定），当作「这些契约组合起来长什么样」的参考，**不是框架要求**。

## 0. 责任边界（先读这段）

MCSTS 只提供**插件接口**。是否安装某个插件、装哪一个，是站点超级管理员的决定；**插件的行为由安装者负责**。

插件运行在 MCSTS 的 Node 进程内，本站**不提供沙盒**：能 `require('fs')` 的代码关不住，假装能关住比说清楚更糟。因此 MCSTS 承诺的是另外几件事：

- 接口稳定：兼容性只看 `PLUGIN_API_VERSION`，已发布的成员只加不改不删；
- 声明可核：插件注册的每个 HTTP 入口都必须在 manifest 里先声明，注册未声明的路径**直接拒载**；
- 看得见：面板展示 manifest 描述、声明的外部依赖、暴露的入口、启停与操作记录（**这张台账最多留 15 天** —— 它是排障用的，不是审计档案；要长期留痕请自己建表）；
- 炸不穿：插件加载失败或事件回调抛错，不影响站点与别的插件。

**文案归属**：面板的界面文字（按钮、表头、状态与枚举名）由本站提供四语言；
而 manifest 里的 `name` / `description` / `settings[].label` / `settings[].hint` /
`requires[].label` / `requires[].note`，以及插件响应体里的 `message`，**都是作者写的文字，
本站原样透传、不翻译、不做语言回退**。要多语言版本请在自己的 manifest 里决定
（本站不会替你判断一段文字是什么语言）。同理，插件的界面只有面板里那张卡片 ——
面板不渲染作者提供的 HTML，也不开放注入站点 UI 的口子。

## 1. 安装位置与开关

| 项 | 值 |
|---|---|
| 启用开关 | 环境变量 `MCSTS_PLUGINS=1`（默认关闭；关闭时 `/api/plugins` 根本不存在） |
| 插件目录 | `MCSTS_PLUGIN_DIR`，默认 `./data/plugins` |
| 目录形态 | `data/plugins/<插件目录>/mcsts.plugin.json` + 入口文件 |

`data/` 在 MCSTS 的 `.gitignore` 里，所以插件本体不会混进站点仓库。目录名不必等于 manifest 的 `id`（以 `id` 为准，不一致时启动日志会提示）。

启用/停用**不需要重启进程**：面板上点一下就生效。

## 2. manifest（`mcsts.plugin.json`）

```json
{
  "id": "bulletin",
  "name": "站内公告板",
  "version": "0.1.0",
  "apiVersion": 1,
  "mcsts": ">=2-26.4.2",
  "main": "index.ts",
  "author": "you",
  "description": "玩家可读写的一块公告板：网页侧读写，外部系统可带签名推送",
  "requires": [
    { "id": "companion", "label": "外部推送方", "note": "可选：没有它只是少了机器推送，网页侧照常" }
  ],
  "settings": [
    { "key": "BOARD_TITLE", "type": "string", "label": "公告板标题", "default": "公告" },
    { "key": "PUSH_SECRET", "type": "secret", "label": "推送方共享密钥", "hint": "填进你的推送服务配置" }
  ],
  "endpoints": [
    { "kind": "router", "method": "GET",  "path": "/list", "auth": "public", "note": "读公告列表" },
    { "kind": "router", "method": "POST", "path": "/publish", "auth": "user", "note": "登录玩家发公告" },
    { "kind": "hooks",  "method": "POST", "path": "/push", "auth": "hmac", "note": "外部系统带签名推送",
      "rateLimit": { "max": 30, "windowMs": 60000 } }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 小写字母开头，允许数字与下划线，长度 2-32。它同时是你的表前缀 |
| `name` / `version` / `main` | ✅ | `main` 是相对插件目录的入口文件 |
| `apiVersion` | ✅ | 必须等于 MCSTS 的 `PLUGIN_API_VERSION`，否则拒载 |
| `mcsts` | — | 展示用（面板显示「要求站点版本」）。**不做版本比较**，闸门是 `apiVersion` |
| `requires` | — | 外部依赖声明。MCSTS 探测不到你的环境里装了什么，所以这是**提示**而不是检测 |
| `settings` | — | 设置项声明；`secret` 型加密入库，面板只回「是否已设置」 |
| `endpoints` | — | 你要暴露的入口。注册未声明的路径会被拒载 |
| `binding` | — | 需要玩家自助绑定页时才写，见 §5 |

## 3. 入口与生命周期

```ts
import type { PluginSetup } from './plugin-api.js';

const setup: PluginSetup = async (ctx) => {
  const table = ctx.table('posts');         // → plugin_bulletin_posts
  await ctx.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (...)`);

  ctx.route({ method: 'GET', path: '/list', auth: 'public' }, async (_req, res) => {
    res.json({ posts: await ctx.db.query(`SELECT * FROM ${table}`) });
  });

  return () => { /* 停用时清理：关连接、清定时器 */ };
};

export default setup;
```

`setup` 可以同步返回清理函数，也可以 `await` 完初始化再返回。MCSTS 停用它时先调你的清理函数，再摘掉事件订阅与路由。

挂载规则只有两条：`ctx.route` 挂在 `/api/plugins/<id><path>`，网页侧鉴权等级与 manifest 同源（`public` / `user` / `admin` / `super`，后三者复用站点会话并按角色抬门槛）；`ctx.hook` 挂在 `/api/plugins/<id>/hooks<path>`（`auth:'hmac'` 由 MCSTS 校验签名，见 §6）。

## 4. `ctx` 能力一览

| 能力 | 用途 | 注意 |
|---|---|---|
| `ctx.table(name)` | 拼带前缀表名 | 表名片段只允许 `[a-z][a-z0-9_]*` |
| `ctx.db` | `query/run/exec/transaction` + `dialect` | 占位符两边不同：SQLite `?`、PG `$1`，用 `ctx.db.dialect` 分支 |
| `ctx.settings` | 读写 `plugin.<id>.*` | 键名用 manifest 里声明的那些；`getSecret()` 拿明文 |
| `ctx.tokens` | 一次性令牌 | 消费是原子的，见 §7 |
| `ctx.events` | 订阅生命周期事件 | 只读通知，**不能改写核心决定** |
| `ctx.route()` | 网页侧入口 `/api/plugins/<id><path>` | 鉴权等级 `public/user/admin/super` |
| `ctx.hook()` | 机器回调 `/api/plugins/<id>/hooks<path>` | `auth:'hmac'` 由 MCSTS 校验签名 |
| `ctx.binding()` | 接入账号设置区的**通用绑定页** | manifest 要先声明 `binding`，见 §5 |
| `ctx.textures` | 取某角色当前素材的签名纹理 property | 复用核心 Yggdrasil 构建链路；角色没素材时回 `null` |
| `ctx.site` | 站点标题 / 对外根 / RSA 公钥 | 只读；公钥见 §6 末 |
| `ctx.logger` | 带 `[plugin:<id>]` 前缀的日志 | — |

### 表与设置的所有权

- 你的表由**你**建（`setup` 里 `CREATE TABLE IF NOT EXISTS`），MCSTS 不替你管迁移；卸载时你自己决定要不要 `DROP`。
- 设置存在站点的 `system_settings` 里，键前缀 `plugin.<id>.`，命名空间互不可见。
- **不要**读写别的插件的表或设置键。这不是技术强制（进程内拦不住），是契约。

### 事件是通知，不是拦截器

`ctx.events.on(name, handler)` 收到的是「已经发生的事」：`user.registered`、`profile.renamed`、`profile.reserved`（角色被换下转预留）、`profile.deleted`、`account.purged`。MCSTS **不 await** 你的处理结果，也不会因为你的返回值改变已完成的业务决定。

这是刻意的：可返回覆盖值的拦截器会让插件顺序影响结果，排查成本指数级上升。需要改变行为，请走显式入口。

## 5. 玩家侧：通用绑定页（`ctx.binding()`）

很多插件需要「玩家把一个**站外身份或值**绑到自己的账号/角色上」。MCSTS 把这块页面做进了账号设置区（登录用户的「账号绑定」），插件只登记行为，**不写任何前端代码**：

- `list(actor)` —— 该主体当前的绑定行 + 一段给玩家看的说明文字；
- `claim(actor & { value })` —— 玩家在页面上提交一个值，提出申请；
- `revoke(actor & { bindingId })` —— 玩家本人在网页侧解绑（不登记就没有解绑按钮）。

```ts
ctx.binding({
  // 核心已验过 actor.profileId 属于这个登录账号（subject='profile' 时），
  // 插件不需要、也没有能力再去查归属 —— 这是结构上挡住的，不是靠作者自觉
  async list(actor) {
    return {
      bindings: [{
        id: 'ext-10086',
        fields: [{ label: '远端身份', value: 'ext-10086' }, { label: '角色', value: actor.profileName ?? '' }],
        boundAt: '2026-10-01T06:02:24Z',
        status: 'pending',          // 'pending' 待确认 / 'active' 已生效
      }],
      instructions: '在对方系统里完成一次动作后，把它显示给你的编号填进来提交。',
    };
  },
  // manifest 的 binding.input.pattern 已由核心预校验，这里只写业务判定
  async claim(actor) {
    if (await alreadyActiveForOtherProfile(actor.value, actor.profileId)) {
      return { message: '该编号已绑定其他角色，无法申请' };   // message 原样显示给玩家
    }
    await insertPending(actor.value, actor.profileId, actor.profileName);
    return { message: '申请已记录，对方系统观测到后自动生效' };
  },
  async revoke(actor) {
    await ctx.db.run(`DELETE FROM ${table} WHERE ext_id = ${ph(0)} AND profile_id = ${ph(1)}`, [actor.bindingId, actor.profileId]);
  },
});
```

规则与约定：

- **manifest 必须先声明** `"binding": { "subject": "profile" }`（或 `"account"`）。没声明就调
  `ctx.binding()` → 拒载，和未声明的 endpoints 同一条承诺；声明了却没登记实现 → 入口回 503 说明原因，
  而不是无声 404。
- `subject='profile'`：页面给角色选择器，核心把**验过归属**的 `profileId`/`profileName` 交给你的三个函数，
  缺了或不属于这个账号的请求根本到不了插件；`subject='account'` 时 `profileId` 恒为 null。
- 核心提供的入口（面板的「对外入口」台账会按声明替你把实际存在的行摊出来）：
  `GET /api/plugins/<id>/binding`、`POST …/binding/claim`、`POST …/binding/revoke`，全部登录用户鉴权；
  另有 `GET /api/bindings` 供页面发现「哪些启用的插件有绑定能力」（目录行含 `claimable/revocable`）。
- **返回形态由核心校验**：`list()` 必须回 `{ bindings: [{ id, fields: [{label,value}], boundAt?, status? }], instructions? }`
  （`status` 可选 `'pending' | 'active'`，页面渲染成「待确认 / 已生效」），
  `claim()` 可回 `{ message }` 由页面原样显示。不合契约直接报 `PLUGIN_BAD_RESULT` 并指名你的插件 ——
  宁可报错，也不让页面渲染出半坏列表让你猜哪行错了。
- `claim` 按 用户+IP 限 10 次/分钟（核心做的，不用你自己写）。
- **敏感值请标 `secret`**：`fields[]` 里那一项写 `{ label, value, secret: true }`，页面默认整串打星、
  玩家自己点眼睛显隐，打码态同时收起复制按钮。防的是旁观屏幕与截图 —— 值本身仍随响应发给**该绑定
  的主人**（只有登录本人读得到），所以它是防窥而不是加密传输；不要把只有管理员该看的字段塞进 `list()`。
- **申请制的两步证据**：`claim` 表达的只是**意愿**（站号主人想绑这个站外身份）；可信的**持有证明**
  应由你的外部系统在观测到该身份真实出现的那一刻，带签名回调你的 hooks 端点（§6）把 `pending` 翻成
  `active`。只有意愿没有观测 → 永远停在 `pending`；只有观测没有意愿 → 查无此行，什么都不发生。
  把观测到的昵称/显示名一并记录并显示在绑定行上，本人一眼可辨伪、可自助解绑。
- **绑定要跟随主体的存亡与身份变化**：订阅 `profile.renamed` 同步展示副本；订阅 `profile.deleted` /
  `account.purged` 删行；还要订阅 `profile.reserved` —— 角色被换下（多→单切换、单模式下换 ID）时它不再是
  可用身份，绑定必须**丢弃**并释放对方身份，否则一个进不去的旧角色会一直占着别人的编号。
- 一个实用细节：钩子侧（`/hooks/…`）只有 `profileId`，**查不到角色名字** —— 名字在 `claim` 时刻是齐的，
  存进你自己的表，回调时就能带回来。

### 码制（`issue`）：兼容形态，新插件别选

核心为兼容旧插件保留「网页生成一次性码 → 别处消费」的形态：不写 `"binding": { "issue": false }` 时
**必须**登记 `issue()`。新插件请写 `issue: false` 走上面的申请制 —— 此时 `POST …/binding/issue` 回 501、
登记 `issue()` 反而拒载（声明与实际行为必须一致，那是永远跑不到的死代码）、绑定页不出现生成码按钮。
理由：申请制覆盖同一件事且更强，中间不需要一枚能被抄走、能被截屏的短码。

## 6. 机器侧：入站回调与签名（`auth: 'hmac'`）

MCSTS 从不主动连你的服务器，方向是**入站**：任何持有共享密钥的外部系统（游戏服伴生插件、你的后端、CI）回调 MCSTS。为了确认「这条请求确实来自配了同一把密钥的那一方」，约定：

```
签名串 = ts + "\n" + nonce + "\n" + METHOD + "\n" + 完整路径 + "\n" + sha256hex(body)
签名   = HMAC-SHA256(secret, 签名串) 的十六进制小写
```

三个请求头：

| 头 | 内容 |
|---|---|
| `X-MCSTS-Timestamp` | 毫秒时间戳，与站点时钟差须在 ±120s 内 |
| `X-MCSTS-Nonce` | 8-64 位 `[A-Za-z0-9_-]`，窗口内不可重复 |
| `X-MCSTS-Signature` | 上面的十六进制签名 |

`完整路径` 是挂载后的路径（如 `/api/plugins/bulletin/hooks/push`），不是 manifest 里那段 —— 否则一个合法签名可以换到别的路径上重放。`body` 按 JSON 文本参与哈希。

密钥由超管在面板「服务器密钥」处生成，明文只显示一次；插件用 `ctx.settings.getSecret('HOOK_SECRET')` 读（键名固定 `HOOK_SECRET`，由框架托管，不用你在 settings 里声明）。manifest 里给 hooks 入口写 `rateLimit` 可以按「插件 + 来源 IP」限流（这类调用没有账号可言，不限量则泄露路径后可无限试探签名）。

未配 Redis 时 nonce 记录降级为进程内存：重启即清空、多实例各记各的。这不影响签名校验本身。

### 附带能力：`ctx.site.publicKeyPem()`

站点有一把 Yggdrasil RSA 私钥（签发 textures 用）。插件可以读到**公钥**：外部系统把玩家带来的
textures property（value + signature）发回你的 hooks 端点时，你用公钥验签 —— 只有本站签得出的才过。
私钥永远不经插件 API 出手；站点尚未生成密钥时返回 `null`。

## 7. 一次性令牌（`ctx.tokens`）

邀请、兑换这类场景确实需要短码时用 `ctx.tokens`，别自己写「查存在 → 标记已用」两句式消费：那中间有竞态，并发两条都能过检查。`ctx.tokens.consume()` 把判定写进一条带 `WHERE ... AND used_at IS NULL` 的原子语句，靠数据库定胜负。

另外三条约定：明文**不入库**（库里只有 sha256）；消费失败一律返回 `null`（不区分不存在/已用/过期，否则端点变成探测器）；令牌的 `data` 可以带上签发时刻才知道的信息（如角色名），消费时原样取回。

## 8. 最小完整例子（与领域无关）

把 §2 的 manifest 与下面的入口放在一起就是一个能装能跑的插件：公开读、登录写、外部系统带签名推送、订阅注册事件、设置项即时生效。

```ts
import type { PluginSetup } from './plugin-api.js';

const setup: PluginSetup = async (ctx) => {
  const table = ctx.table('posts');
  const ph = (i: number): string => (ctx.db.dialect === 'postgres' ? `$${i + 1}` : '?');
  await ctx.db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id INTEGER PRIMARY KEY, body TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL)`,
  );

  ctx.route({ method: 'GET', path: '/list', auth: 'public' }, async (_req, res) => {
    const title = String((await ctx.settings.get('BOARD_TITLE')) ?? '公告');
    res.json({ title, posts: await ctx.db.query(`SELECT body, author, at FROM ${table} ORDER BY id DESC`) });
  });

  ctx.route({ method: 'POST', path: '/publish', auth: 'user' }, async (req, res) => {
    const body = String((req.body ?? {})['body'] ?? '').trim();
    if (body === '' || body.length > 200) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '公告 1-200 字' });
      return;
    }
    await ctx.db.run(`INSERT INTO ${table} (body, author, at) VALUES (${ph(0)}, ${ph(1)}, ${ph(2)})`,
      [body, req.context!.userId, new Date().toISOString()]);
    res.json({ ok: true });
  });

  // 外部系统推送：HMAC 已证明对方持有密钥，这里只做形态校验
  ctx.hook({ method: 'POST', path: '/push', auth: 'hmac' }, async (req, res) => {
    const body = String(req.body['body'] ?? '').trim();
    if (body === '') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'body 必填' });
      return;
    }
    await ctx.db.run(`INSERT INTO ${table} (body, author, at) VALUES (${ph(0)}, ${ph(1)}, ${ph(2)})`,
      [body, 'system', new Date().toISOString()]);
    res.json({ ok: true });
  });

  ctx.events.on('user.registered', async (payload) => {
    ctx.logger.info('新账号注册', { userId: payload.userId });
  });

  return () => { /* 本例无外部资源要清理 */ };
};

export default setup;
```

装起来跑一遍（本地）：把目录放进 `MCSTS_PLUGIN_DIR` → 面板「重新扫描插件目录」→ 卡片上点「启用」→
`curl http://<站点>/api/plugins/bulletin/list`。**安装/扫描只到「发现」，启用永远是你或超管的显式动作。**

## 9. 案例研究：基岩身份绑定（官方插件 `bedrock_link`）

> 案例，不是框架要求。它是目前唯一被真机完整验过的插件，仓库形态可以直接抄：
> `SunsetNightMoon/Bedrock-Link-Java` 的 `site/` 子目录（v2-26.4.3 起「子目录」留空即可，导入器会认那唯一一份 manifest）。

场景：Java 服务器用 MCSTS 外置登录（authlib-injector），玩家身份就是站点角色；Xbox 基岩玩家经 Geyser 进来时带的是 XUID，需要「签证」绑到某个角色才能进服并穿站点皮肤。它把 §5/§6 的契约组合成：

1. **意愿** —— 玩家在「账号绑定」页选角色、提交他的 XUID（进服被拦时屏幕上会显示），状态落 `pending`；
2. **持有** —— 他重新进基岩服的那一刻，Floodgate 对 Xbox 会话实测的 XUID 出现在进服事件里（在线服不可伪造），伴生插件带签名回调 `/hooks/confirm`，把这条 `pending` 签发为 `active` 并记录实测昵称。

从这个案例里沉淀出的约定（写任何「站外身份绑定」都适用）：

- 绑定存**主体 UUID**，不存显示名（名字会变，存名字会让改名静默打断绑定）；订阅 §5 列的三个事件跟随。
- 双向唯一（一个站外身份只绑一个主体、反之亦然）；历史数据已冲突时**不要任选一条**，一律拒绝并记日志。`pending` 阶段允许改主意，`active` 之后必须先解绑。
- 解绑只允许网页侧（玩家本人）操作；外部系统不许单方面解绑。
- 「仅限本站玩家」这类准入判断走 `/hooks/verify`：把对方带来的、由本站签出的凭据发回，用 `ctx.site.publicKeyPem()` 验签并核对身份自洽。

Minecraft 特有的两件事，只在这个案例里成立：

- **皮肤落地分两个方向**（此前文档写过「把 value/signature 塞进 profile properties 就够了」，**那半句是错的**，已订正）：Java 侧看绑定者的皮肤走标准 textures property；基岩客户端自己不渲染 Java 的 property，但基岩协议 SerializedSkin 自带皮肤+披风槽位，取回站点图经 Geyser 皮肤接口推送即可（披风实测可见，2026-10-01 于 Geyser 2.11.3 复验），推送会覆盖客户端自带皮肤。硬限制只剩两处：**物品栏纸娃娃与第一人称手臂永远渲染客户端本地皮肤**，任何服务器方案都改不了。
- 持有证明的强度来自 Floodgate 对 Xbox 会话的实测（微软背书）；换别的游戏/平台时，先问清楚你的「观测」伪造成本有多高，再决定申请制够不够。

## 10. 发布与导入（GitHub）

除了手工把目录放进 `MCSTS_PLUGIN_DIR`，超管可以在面板点「从 GitHub 导入」。要让插件能被这条路径装上，仓库需要满足：

**① 目录形态**：`mcsts.plugin.json` 与入口文件放在一起（仓库根，或 monorepo 的某个子目录）。
「子目录」**通常留空**：仓库根没有 manifest 而整棵树恰好只有一份时，导入器直接认它所在的目录
（预览摘要会显示「自动识别子目录 …」）。一份仓库里放多个插件是真 monorepo，这时不猜 ——
把「子目录」填成目标那一份所在的路径。手动填的值永远优先。标记文件则**永远看仓库根**，
所以伴生 jar、文档这些别的东西不妨碍导入。

**② 识别代号标记**：仓库根必须有 `.mcsts-plugin/<id>.json`，内容形如

```json
{ "id": "my_plugin", "name": "我的插件", "author": "someone", "repository": "someone/mcsts-my-plugin" }
```

四个字段会与 manifest **逐项比对**（`author` 在 manifest 没填时按空串比）。它的作用是给出一个可核对的声明：这个仓库认领了这个识别代号。标记缺失或对不上，导入直接被拒 —— 这是导入唯一的硬门槛，也是它全部的承诺：**它不证明代码无害**（见 §0）。

**③ 打语义化版本的 tag**：版本由站点**自动识别** —— 它列出仓库的 tag，取其中最新的**语义化版本**（`v1.2.3`、`1.2.3`、`1.2.3-rc.1` 都算；`latest`、`snapshot-0930`、两段号 `v1.2` 都不算），再把选中的 tag 解析成 commit sha，之后所有文件都按那个 sha 取。一个可识别的 tag 都没有 → 导入被拒，并列出它扫到的 tag 名。不接受分支或裸 sha：分支会往前走，而「预览看到的那一份 = 装进磁盘的那一份」只能是 sha。安装时会再解析一次并比对，tag 被重打或期间又发了新版都会中止，让你重新预览。

选中的 tag 去掉 `v` 后与 manifest 的 `version` 不一致时，面板会给一条警告 —— **只提示，不拦安装**，装的是那个 commit。

**④ 只放文本文件**：允许 `.ts .mts .cts .js .mjs .cjs .json .md .txt`；单文件 ≤ 512 KB、总量 ≤ 4 MB、文件数 ≤ 200。出现二进制或未知类型（含 `.wasm`、图片、字体）整包被拒 —— 「插件是纯文本、可以逐行读过」是对安装者最有用的保证。

导入分两步：**预览**（不写盘，列出文件清单、体积、manifest 摘要、标记核对结果、自动选中的 tag 与解析出的 sha、扫过多少个 tag）→ **安装**。安装只做「落盘 + 发现」，**不会自动启用**，与手工放目录完全一致。装完目录里会多一份 `.mcsts-import.json`，记着来源仓库、tag、commit sha、每个文件的 git blob sha、以及谁在什么时候装的 —— 别手改它，重装会覆盖。

面板上那一栏要贴的是**仓库地址**，形态随你手边有什么：`https://github.com/owner/repo.git`、仓库网页地址（尾上的 `/tree/…`、`/releases/tag/…` 会被忽略）、`git@github.com:owner/repo.git`、`owner/repo`，或「镜像前缀 + 完整 GitHub 地址」。**地址只决定装哪个仓库，不决定往哪台主机发请求** —— 请求主机是部署侧的 `MCSTS_PLUGIN_MIRROR`（见部署要点）。非 GitHub 的域名（Gitee、自建 GitLab 等）会被点名拒绝，而不是去 GitHub 找一个同名仓库：认错仓库比报错严重。

私有仓库或撞限流时给站点进程配 `MCSTS_GH_TOKEN`（只从环境变量读，不进站点设置、不出现在任何接口响应里）。

## 11. 调试与常见失败

| 现象 | 原因 |
|---|---|
| 面板显示 `invalid` + 一串字段错误 | manifest 校验没过（最常见：`id` 含连字符、`apiVersion` 不匹配） |
| 启用后 `error: 注册了 manifest 里没声明的入口` | 你 `ctx.route/hook` 的 `kind+method+path` 三元组没写进 `endpoints` |
| 入口全部 404 | 插件没启用，或 `MCSTS_PLUGINS` 没设 |
| 回调 403 `bad_signature` | 签名串里用了相对路径；或 body 序列化与发送不一致；或密钥不一致 |
| 回调 403 `replayed` | 同一 nonce 在窗口内用了第二次（每次请求都要新 nonce） |
| 回调 403 `missing_header` | 三个头缺一个；或该插件还没在面板生成服务器密钥 |
| `密文解密失败` | 站点换过 `MCSTS_SECRET`，插件设置里的密文解不开 —— 重新保存该设置 |
| 按「重载」后代码没变 | **重载只重跑 `setup`，换不掉已导入的模块**（tsx 会把 URL 上的版本参数归一掉）。面板会标出这条提示，改代码请重启站点 |
| 导入报 `无法访问 <主机>：…` | 上游问题（DNS / 连不上 / 限流 / 镜像不转发这条路径），不是仓库不合规；稍后重试，或配 `MCSTS_GH_TOKEN`。文案里点名的就是实际请求的主机 —— 配了 `MCSTS_PLUGIN_MIRROR` 时它是镜像域名 |
| 导入报 `没有可识别的语义化版本 tag` | 仓库的 tag 不是 `v1.2.3` 这种三段号（`latest`、`v1.2`、`snapshot-0930` 都不算）；按语义化版本重新打一个 tag |
| 导入报 `只支持 GitHub 的插件仓库，这个地址的主机是 …` | 粘的是 Gitee / 自建 GitLab / 纯镜像域名地址。要用镜像就把镜像配在 `MCSTS_PLUGIN_MIRROR`，或粘「镜像前缀 + 完整 GitHub 地址」 |
| 导入报 `识别代号标记未通过` | 仓库缺 `.mcsts-plugin/<id>.json`，或其字段与 manifest 不一致 |

## 12. 参考文件

- `plugin-api.d.ts`（仓库根）：唯一的类型来源，复制到你的插件目录用；
- `tests/fixtures/plugins/`：MCSTS 自带的夹具插件，**只 import `plugin-api.d.ts` 的类型**，可当最小可运行示例；
- `tests/plugins.test.ts`：这些能力的行为契约（含失败隔离与签名校验的具体断言）；
- `tests/pluginImport.test.ts`：导入的判定契约（标记核对、清单上限、逐字节核对、上游与请求错误分开）。
