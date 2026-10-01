# MCSTS 插件开发指南

**简体中文** | 本文写给插件作者。它假设你**看不到 MCSTS 的源码** —— 如果你发现自己必须去猜核心实现才能把插件写下去，那是这份文档的缺陷，请反馈。

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
  "id": "bedrock_link",
  "name": "基岩版身份绑定",
  "version": "0.1.0",
  "apiVersion": 1,
  "mcsts": ">=2-26.3.8",
  "main": "index.ts",
  "author": "you",
  "description": "把 Xbox 基岩身份绑到站点角色，让 Geyser 玩家穿 Java 侧皮肤",
  "requires": [
    { "id": "geyser", "label": "GeyserMC + Floodgate", "note": "没有它基岩玩家无法进入 Java 服务器；本插件只做身份绑定，不翻译协议" }
  ],
  "settings": [
    { "key": "GREETING", "type": "string", "label": "问候语", "default": "hi" },
    { "key": "SERVER_SECRET", "type": "secret", "label": "共享密钥", "hint": "填进 Java 服侧伴生插件" }
  ],
  "binding": { "subject": "profile" },
  "endpoints": [
    { "kind": "router", "method": "GET", "path": "/ping", "auth": "public", "note": "健康探针" },
    { "kind": "hooks",  "method": "POST", "path": "/bind", "auth": "hmac", "note": "服务器实测身份 + 玩家码 → 绑定",
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
| `requires` | — | 外部依赖声明。MCSTS 探测不到你的服务器装了什么，所以这是**提示**而不是检测 |
| `settings` | — | 设置项声明；`secret` 型加密入库，面板只回「是否已设置」 |
| `endpoints` | — | 你要暴露的入口。注册未声明的路径会被拒载 |

## 3. 入口

```ts
import type { PluginSetup } from './plugin-api.js';

const setup: PluginSetup = async (ctx) => {
  const table = ctx.table('bindings');      // → plugin_bedrock_link_bindings
  await ctx.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (...)`);

  ctx.route({ method: 'GET', path: '/ping', auth: 'public' }, (_req, res) => {
    res.json({ ok: true });
  });

  return () => { /* 停用时清理：关连接、清定时器 */ };
};

export default setup;
```

`setup` 可以同步返回清理函数，也可以 `await` 完初始化再返回。MCSTS 停用它时先调你的清理函数，再摘掉事件订阅与路由。

## 4. `ctx` 能力一览

| 能力 | 用途 | 注意 |
|---|---|---|
| `ctx.table(name)` | 拼带前缀表名 | 表名片段只允许 `[a-z][a-z0-9_]*` |
| `ctx.db` | `query/run/exec/transaction` + `dialect` | 占位符两边不同：SQLite `?`、PG `$1`，用 `ctx.db.dialect` 分支 |
| `ctx.settings` | 读写 `plugin.<id>.*` | 键名用 manifest 里声明的那些；`getSecret()` 拿明文 |
| `ctx.tokens` | 一次性码 | 消费是原子的，见下节 |
| `ctx.events` | 订阅生命周期事件 | 只读通知，**不能改写核心决定** |
| `ctx.route()` | 网页侧入口 `/api/plugins/<id><path>` | 鉴权复用站点会话 |
| `ctx.hook()` | 机器回调 `/api/plugins/<id>/hooks<path>` | `auth:'hmac'` 由 MCSTS 校验签名 |
| `ctx.binding()` | 接入账号设置区的**通用绑定页** | manifest 要先声明 `binding`，见下 |
| `ctx.site` | 站点标题 / 对外根 | 只读 |
| `ctx.logger` | 带 `[plugin:<id>]` 前缀的日志 | — |

### 表与设置的所有权

- 你的表由**你**建（`setup` 里 `CREATE TABLE IF NOT EXISTS`），MCSTS 不替你管迁移；卸载时你自己决定要不要 `DROP`。
- 设置存在站点的 `system_settings` 里，键前缀 `plugin.<id>.`，命名空间互不可见。
- **不要**读写别的插件的表或设置键。这不是技术强制（进程内拦不住），是契约。

### 事件是通知，不是拦截器

`ctx.events.on(name, handler)` 收到的是「已经发生的事」：`user.registered`、`profile.renamed`、`profile.reserved`（角色被换下转预留）、`profile.deleted`、`account.purged`。MCSTS **不 await** 你的处理结果，也不会因为你的返回值改变已完成的业务决定。

这是刻意的：可返回覆盖值的拦截器会让插件顺序影响结果，排查成本指数级上升。需要改变行为，请走显式入口。

### 通用绑定页（`ctx.binding()`）

「玩家在自己账号里对某个角色提交一个值（如 XUID）、由远端实测签发」是绑定类插件共同的动作。MCSTS 把这块页面做进了
账号设置区（登录用户的「账号绑定」），插件只登记行为，**不写任何前端代码**：

```ts
ctx.binding({
  // 列出当前主体的绑定。核心已验过 actor.profileId 属于这个登录账号（subject='profile' 时），
  // 插件不需要、也没有能力再去查归属 —— 这是结构上挡住的，不是靠作者自觉
  async list(actor) {
    return {
      bindings: [{
        id: '2535449773834232',
        fields: [{ label: 'XUID', value: '2535449773834232' }, { label: '角色', value: 'Steve' }],
        boundAt: '2026-09-30T06:02:24Z',
        status: 'pending',          // 'pending' 待确认 / 'active' 已生效
      }],
      instructions: '用基岩版加入服务器 bedrock.example.com:19132；被拦下的屏幕会显示你的 XUID，填进来提交申请，重新进服的那一刻签发。',
    };
  },
  // 玩家提交申请。manifest 的 binding.input.pattern 已由核心预校验，这里只写业务判定
  async claim(actor) {
    if (await alreadyActiveForOtherProfile(actor.value, actor.profileId)) {
      return { message: '该 XUID 已绑定其他角色，无法申请' };   // message 原样显示给玩家
    }
    await insertPending(actor.value, actor.profileId, actor.profileName);
    return { message: '申请已记录：重新进入基岩服务器的那一刻自动签发生效' };
  },
  // 不登记就没有解绑按钮（有些绑定只许管理员清）
  async revoke(actor) {
    await ctx.db.run(`DELETE FROM ${table} WHERE xuid = ${ph(0)} AND profile_id = ${ph(1)}`, [actor.bindingId, actor.profileId]);
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
- **新插件请走申请制**：`"binding": { "issue": false }` + `claim()`，`POST …/binding/issue` 回 501，
  此时登记 `issue()` 反而拒载（声明与实际行为必须一致，那是永远跑不到的死代码），绑定页不出现「生成绑定码」按钮。
  核心为兼容旧插件仍保留码制默认（不写 `issue:false` 就必须登记 `issue()`），但官方插件自 v2.2.0 起已退役码制，
  新设计不要再选它（理由见 §5）。
- **返回形态由核心校验**：`list()` 必须回 `{ bindings: [{ id, fields: [{label,value}], boundAt?, status? }], instructions? }`
  （`status` 可选 `'pending' | 'active'`，页面渲染成「待确认 / 已生效」），
  `claim()` 可回 `{ message }` 由页面原样显示。不合契约直接报 `PLUGIN_BAD_RESULT` 并指名你的插件 ——
  宁可报错，也不让页面渲染出半坏列表让你猜哪行错了。
- `claim` 按 用户+IP 限 10 次/分钟（核心做的，不用你自己写）。
- 一个实用细节：钩子侧（`/hooks/…`）只有 `profileId`，**查不到角色名字** —— 名字在 `claim` 时刻是齐的，
  存进你自己的表（或令牌的 `data`），回调时就能带回来（上面的例子就是把 `profileName` 存表里）。

### 申请制与签发状态（签证模型）：`claim()`

有些绑定的可信证据不在网页侧，而在**远端服务器观测到该身份真实出现的那一刻**（典型：基岩 XUID
由 Floodgate 在进服时实测，微软背书、在线服不可伪造）。这类流程走「申请 → 进服签发」两步：

```json
"binding": {
  "subject": "profile",
  "input": { "label": "XUID", "pattern": "^[0-9]{6,21}$", "hint": "进服被拦时屏幕上会显示你的 XUID" }
}
```

```ts
ctx.binding({
  async list(actor) { /* 行可带 status: 'pending' | 'active' */ },
  async claim(actor) {
    // actor.value 已由核心按 pattern 校验过；这里写「待确认」记录即可
    return { message: '申请已记录，进服后自动生效' };  // 文案原样显示给玩家（作者语言，框架不翻译）
  },
  // 服务器侧伴生插件实测到该 XUID 进服时调你的 hooks 端点，把 pending 翻成 active
});
```

- 没声明 `input` 就登记 `claim()` → **拒载**：输入框会出现在玩家页面上，超管必须先在 manifest 看到它。
- 安全口径：申请只是**意愿**（站号主人想绑这个远端身份），进服观测才是**持有证明**；两者都齐才签发。
  残余风险是「知道别人 XUID 的人抢先申请」——把进服时观测到的游戏昵称一并记录并显示在绑定行上，
  本人一眼可辨、可自助解绑。
- **绑定要跟随角色的存亡与身份变化**：订阅 `profile.renamed` 同步展示副本；
  订阅 `profile.deleted` / `account.purged` 删行；还要订阅 `profile.reserved` ——
  角色被换下（多→单切换、单模式下换 ID）时它不再是可用身份，绑定必须**丢弃**并释放对方身份，
  否则一个进不了服的旧角色会一直占着别人的 XUID。

### `ctx.site.publicKeyPem()`：验「签证是否真实存在」

站点有一把 Yggdrasil RSA 私钥（签发 textures 用）。插件可以读到**公钥**：伴生插件把玩家带来的
textures property（value + signature）发回你的 hooks 端点，你用公钥验签——只有本站签得出的才过。
私钥永远不经插件 API 出手；站点尚未生成密钥时返回 `null`。

## 5. 绑定契约：`ctx.binding()` 与申请制

绑定类流程的页面由核心提供（账号设置区的「账号绑定」），插件只登记三个回调：

- `list(actor)` —— 该角色当前的绑定行 + 一段给玩家看的说明文字；
- `claim(actor & { value })` —— 玩家在页面上提交一个值（如 XUID）提出申请；
- `revoke(actor & { bindingId })` —— 玩家本人在网页侧解绑。

核心替你把三件最容易写错的事做掉了：

- **归属**：`actor.profileId` 一定属于当前会话账号（核心查过库），「拿别人的 profileId 绑/解绑」在结构上不可能；
- **格式**：manifest 里 `binding.input.pattern` 由核心预校验，插件不必为「页面被塞了脏值」写防御代码；
- **状态机展示**：`status` 只认 `pending` / `active`，`fields` 是 `{label, value}` 列表，页面照原样渲染（插件作者写的文字不翻译，见 §0）。

**官方插件自 v2.2.0 起退役了码制**（`bedrock_link` 改纯申请制），新插件默认也该这么选：申请制覆盖了同一件事且更强 —— 玩家的意愿由他在自己账号里提交申请表达，持有证明由服务器实测给出（见 §7），中间不再需要一枚能被抄走、能被截屏的短码。核心为兼容仍保留码制入口（不写 `issue:false` 时的默认形态），但别为新流程选它。

若你的插件在**别的**场景确实需要一次性令牌（邀请、兑换之类），用 `ctx.tokens`，别自己写「查存在 → 标记已用」两句式消费：那中间有竞态，并发两条都能过检查。`ctx.tokens.consume()` 把判定写进一条带 `WHERE ... AND used_at IS NULL` 的原子语句，靠数据库定胜负；明文不入库（只有 sha256），消费失败一律返回 `null`（不区分不存在/已用/过期，否则端点变成探测器）。

## 6. 机器回调的签名（`auth: 'hmac'`）

MCSTS 无法主动连你的 Minecraft 服务器，所以方向是**入站**：Java 服侧的伴生插件回调 MCSTS。为了让 MCSTS 能确认「这条请求确实来自配了同一把密钥的那台服务器」，约定：

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

`完整路径` 是挂载后的路径（如 `/api/plugins/bedrock_link/hooks/lookup`），不是 manifest 里那段 —— 否则一个合法签名可以换到别的路径上重放。`body` 按 JSON 文本参与哈希。

密钥由超管在面板「服务器密钥」处生成，明文只显示一次；插件用 `ctx.settings.getSecret('HOOK_SECRET')` 读（键名固定 `HOOK_SECRET`，由框架托管，不用你在 settings 里声明）。

未配 Redis 时 nonce 记录降级为进程内存：重启即清空、多实例各记各的。这不影响签名校验本身。

## 7. 一个完整例子：基岩身份绑定（申请制签证）

场景：Java 服务器用 MCSTS 外置登录（authlib-injector），玩家身份就是站点角色；Xbox 基岩玩家经 Geyser 进来时带的是 XUID，需要「签证」绑到某个角色才能进服并穿站点皮肤。官方插件 `bedrock_link` 就是照这个模型写的，可以直接抄它的仓库形态。

**两条独立证据，缺一不可**：

1. **意愿** —— 玩家在 MCSTS「账号绑定」页选角色、提交他的 XUID（进服被拦时屏幕上会显示），状态落 `pending`；这一步的页面由核心提供，插件只实现 `claim`；
2. **持有** —— 他重新进基岩服的那一刻，Floodgate 对 Xbox 会话实测的 XUID 出现在进服事件里（在线服不可伪造），伴生插件带签名回调 `/hooks/confirm`，站点把这条 `pending` 签发为 `active` 并记录实测昵称（显示在绑定页上可辨伪）。

只有意愿没有持有 → 申请永远停在 `pending`；只有持有没有意愿 → `confirm` 查无此行，什么都不发生。两者齐了才生效，玩家全程零命令。

其余约定：

- 绑定存**角色 UUID**，不存角色名（角色有改名冷却与名称池，存名字会让改名静默打断绑定）；订阅 `profile.renamed` / `profile.deleted` / `account.purged` 跟随。
- **角色被换下要释放占用**：多角色→单角色、或单模式换 ID 时核心发 `profile.reserved`（事务落定后），预留角色只是名字占位、不再是可用身份，绑定应随之删除、把 XUID 让出来；其余 ID 的绑定直接丢弃是明确语义，不要试图保留。
- 一个 XUID 只绑一个角色、一个角色只绑一个 XUID；两个方向的唯一性都要处理「历史数据已冲突」的情况 —— 冲突时**不要任选一条**，一律拒绝并记日志。`pending` 阶段允许改主意（挪动申请），`active` 之后必须先解绑。
- 解绑只允许网页侧（玩家本人）操作；服务器侧不许单方面解绑。
- Java 侧准入（「仅限外置登录玩家」）走 `/hooks/verify`：伴生插件把玩家 GameProfile 里的 textures property（value + signature）发回，插件用 `ctx.site.publicKeyPem()` 验 RSA 签名并核对名字自洽 —— 只有本站签得出的才过。
- 皮肤落地要分两个方向说清楚（此前这里写过「把 value/signature 塞进 profile properties 就够了」，**那半句是错的**，已订正）：
  - **Java 侧玩家看基岩绑定者的皮肤**：MCSTS 的 RSA 签名纹理输出走标准 textures property，伴生插件把绑定角色的 `value`/`signature` 塞进该连接的 GameProfile 即可，与其他外置登录皮肤同一条链路；
  - **基岩客户端自己穿戴站点皮肤与披风**：基岩版不渲染 Java 的 textures property（含其中的 CAPE），
    但基岩协议 SerializedSkin 自带皮肤+披风槽位，取回站点图经 Geyser 的皮肤接口推送即可（SkinRestorer
    一类扩展走的正是这条路；披风槽位 Geyser API 一直有，实测可见，2026-10-01 于 Geyser 2.11.3 复验）。
    推送会覆盖客户端自带皮肤。真正的硬限制只剩两处：**物品栏纸娃娃与第一人称手臂永远渲染客户端本地皮肤**，
    任何服务器方案（含第三方插件）都改不了；Java 侧玩家看该玩家始终走 property，全套纹理含披风。

## 8. 发布与导入（GitHub）

除了手工把目录放进 `MCSTS_PLUGIN_DIR`，超管可以在面板点「从 GitHub 导入」。要让插件能被这条路径装上，仓库需要满足：

**① 目录形态**：`mcsts.plugin.json` 与入口文件放在一起（仓库根，或 monorepo 的某个子目录）。
住在子目录时，超管要在面板「子目录」里填上它（例：manifest 在 `site/mcsts.plugin.json` 就填 `site`）；
没填时导入会直接把 manifest 的真实位置报出来，并给出该填的值。标记文件则**永远看仓库根**，
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

## 9. 调试与常见失败

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

## 10. 参考文件

- `plugin-api.d.ts`（仓库根）：唯一的类型来源，复制到你的插件目录用；
- `tests/fixtures/plugins/`：MCSTS 自带的夹具插件，**只 import `plugin-api.d.ts` 的类型**，可当最小可运行示例；
- `tests/plugins.test.ts`：这些能力的行为契约（含失败隔离与签名校验的具体断言）；
- `tests/pluginImport.test.ts`：导入的判定契约（标记核对、清单上限、逐字节核对、上游与请求错误分开）。
