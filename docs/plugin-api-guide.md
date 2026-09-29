# MCSTS 插件开发指南

**简体中文** | 本文写给插件作者。它假设你**看不到 MCSTS 的源码** —— 如果你发现自己必须去猜核心实现才能把插件写下去，那是这份文档的缺陷，请反馈。

## 0. 责任边界（先读这段）

MCSTS 只提供**插件接口**。是否安装某个插件、装哪一个，是站点超级管理员的决定；**插件的行为由安装者负责**。

插件运行在 MCSTS 的 Node 进程内，本站**不提供沙盒**：能 `require('fs')` 的代码关不住，假装能关住比说清楚更糟。因此 MCSTS 承诺的是另外几件事：

- 接口稳定：兼容性只看 `PLUGIN_API_VERSION`，已发布的成员只加不改不删；
- 声明可核：插件注册的每个 HTTP 入口都必须在 manifest 里先声明，注册未声明的路径**直接拒载**；
- 看得见：面板展示 manifest 描述、声明的外部依赖、暴露的入口、启停与操作记录；
- 炸不穿：插件加载失败或事件回调抛错，不影响站点与别的插件。

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
| `ctx.site` | 站点标题 / 对外根 | 只读 |
| `ctx.logger` | 带 `[plugin:<id>]` 前缀的日志 | — |

### 表与设置的所有权

- 你的表由**你**建（`setup` 里 `CREATE TABLE IF NOT EXISTS`），MCSTS 不替你管迁移；卸载时你自己决定要不要 `DROP`。
- 设置存在站点的 `system_settings` 里，键前缀 `plugin.<id>.`，命名空间互不可见。
- **不要**读写别的插件的表或设置键。这不是技术强制（进程内拦不住），是契约。

### 事件是通知，不是拦截器

`ctx.events.on(name, handler)` 收到的是「已经发生的事」：`user.registered`、`profile.renamed`、`profile.deleted`、`account.purged`。MCSTS **不 await** 你的处理结果，也不会因为你的返回值改变已完成的业务决定。

这是刻意的：可返回覆盖值的拦截器会让插件顺序影响结果，排查成本指数级上升。需要改变行为，请走显式入口。

## 5. 一次性码：为什么必须用 `ctx.tokens`

绑定这类流程需要「玩家在自己账号里生成一枚短码，到游戏里交给服务器消费」。自己实现很容易写成：

```
查一下这枚码存在且没用过 → 标记已用 → 执行绑定     ← 错
```

这是两个语句，中间有竞态：用户连打两次命令、或脚本并发，两条都能通过检查。`ctx.tokens.consume()` 把全部判定写进 `DELETE ... WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING ...`，靠数据库原子性定胜负 —— 只有一行被更新才算赢。

另外三条约定：

- 明文码**不入库**，库里只有 `sha256(明文)`；
- 码是 8 位大写无歧义字母表（去掉了 I/O/0/1），因为要能在游戏里手输；
- 消费失败一律返回 `null`，不区分「不存在 / 已用过 / 已过期」—— 否则这个端点会变成探测器。

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

`完整路径` 是挂载后的路径（如 `/api/plugins/bedrock_link/hooks/bind`），不是 manifest 里那段 —— 否则一个合法签名可以换到别的路径上重放。`body` 按 JSON 文本参与哈希。

密钥由超管在面板「服务器密钥」处生成，明文只显示一次；插件用 `ctx.settings.getSecret('HOOK_SECRET')` 读（键名固定 `HOOK_SECRET`，由框架托管，不用你在 settings 里声明）。

未配 Redis 时 nonce 记录降级为进程内存：重启即清空、多实例各记各的。这不影响签名校验本身。

## 7. 一个完整例子：基岩身份绑定（模式 A）

场景：Java 服务器用 MCSTS 外置登录（authlib-injector），玩家身份就是站点角色；Xbox 基岩玩家经 Geyser 进来时带的是 XUID，需要绑到某个角色才能穿 Java 侧皮肤。

**两条独立证据，缺一不可**：

1. **玩家授权** —— 他在 MCSTS 网页（已登录）点「生成绑定码」，拿到 8 位码；
2. **服务器实测** —— 他进基岩服执行 `/bedrock link <码>`，伴生插件从 Floodgate 取该连接的**真实 XUID**，带签名回调 MCSTS。

只有码没有签名 → 任何人都能自报 XUID；只有签名没有码 → 拿到服务器密钥的人可以随意给人绑定。两者同时成立才写绑定。

其余约定：

- 绑定存**角色 UUID**，不存角色名（角色有 30 天改名冷却与名称池，存名字会让改名静默打断绑定）；订阅 `profile.renamed` / `profile.deleted` / `account.purged` 跟随。
- 一个 XUID 只绑一个角色、一个角色只绑一个 XUID；两个方向的唯一性都要处理「历史数据已冲突」的情况 —— 冲突时**不要任选一条**，一律拒绝并记日志。
- 解绑只允许网页侧（玩家本人）操作；服务器侧不许单方面解绑。
- 皮肤落地：MCSTS 已有 RSA 签名的纹理输出，`lookup` 类端点可以直接把 `value` / `signature` 交给伴生插件塞进 profile properties，不需要另写 Geyser skin provider。

## 8. 发布与导入（GitHub）

除了手工把目录放进 `MCSTS_PLUGIN_DIR`，超管可以在面板点「从 GitHub 导入」。要让插件能被这条路径装上，仓库需要满足：

**① 目录形态**：`mcsts.plugin.json` 与入口文件放在一起（仓库根，或 monorepo 的某个子目录）。

**② 识别代号标记**：仓库根必须有 `.mcsts-plugin/<id>.json`，内容形如

```json
{ "id": "my_plugin", "name": "我的插件", "author": "someone", "repository": "someone/mcsts-my-plugin" }
```

四个字段会与 manifest **逐项比对**（`author` 在 manifest 没填时按空串比）。它的作用是给出一个可核对的声明：这个仓库认领了这个识别代号。标记缺失或对不上，导入直接被拒 —— 这是导入唯一的硬门槛，也是它全部的承诺：**它不证明代码无害**（见 §0）。

**③ 打 tag**：导入只接受 tag，不接受分支或裸 sha。站点会把 tag 解析成 commit sha，之后所有文件都按那个 sha 取；安装时会再解析一次并比对，tag 被人重打过就中止。

**④ 只放文本文件**：允许 `.ts .mts .cts .js .mjs .cjs .json .md .txt`；单文件 ≤ 512 KB、总量 ≤ 4 MB、文件数 ≤ 200。出现二进制或未知类型（含 `.wasm`、图片、字体）整包被拒 —— 「插件是纯文本、可以逐行读过」是对安装者最有用的保证。

导入分两步：**预览**（不写盘，列出文件清单、体积、manifest 摘要、标记核对结果、解析出的 sha）→ **安装**。安装只做「落盘 + 发现」，**不会自动启用**，与手工放目录完全一致。装完目录里会多一份 `.mcsts-import.json`，记着来源仓库、tag、commit sha、每个文件的 git blob sha、以及谁在什么时候装的 —— 别手改它，重装会覆盖。

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
| 导入报 `无法访问 GitHub：…` | 上游问题（DNS / 连不上 / 限流），不是仓库不合规；稍后重试，或配 `MCSTS_GH_TOKEN` |
| 导入报 `识别代号标记未通过` | 仓库缺 `.mcsts-plugin/<id>.json`，或其字段与 manifest 不一致 |

## 10. 参考文件

- `plugin-api.d.ts`（仓库根）：唯一的类型来源，复制到你的插件目录用；
- `tests/fixtures/plugins/`：MCSTS 自带的夹具插件，**只 import `plugin-api.d.ts` 的类型**，可当最小可运行示例；
- `tests/plugins.test.ts`：这些能力的行为契约（含失败隔离与签名校验的具体断言）；
- `tests/pluginImport.test.ts`：导入的判定契约（标记核对、清单上限、逐字节核对、上游与请求错误分开）。
