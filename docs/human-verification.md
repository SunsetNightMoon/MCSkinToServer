# 人机验证

注册与登录用哪种人机验证，在「管理面板 → 系统设置 → 注册设置」里选，取值存在站点设置 `CAPTCHA_TYPE`：`none` / `math` / `image` / `external`。

老站点只写过布尔 `ENABLE_CAPTCHA` 时按 `true → math`、`false → none` 推导，升级不改变既有行为；枚举值被写坏时同样回落到这个口径，**不会因脏数据变成「谁都不校验」**。

## 四种模式怎么选

| 方式 | 是否出网 | 访客 IP 去向 | 定位 |
|---|---|---|---|
| `none` | — | — | 不启用 |
| `math` 数学题 | 否 | 本站 | 题干明文下发，只挡不解析响应的脚本 |
| `image` 图片题 | 否 | 本站 | 题干只出现在 PNG 里，挡读 JSON 的脚本 |
| `external` 外部服务 | 是 | 所配置的校验端点 | 由所选服务决定，能对抗真实自动化 |

自托管两种都只用于**拦脚本**，对打码平台和人工注册无效；优点是零外部依赖、零合规负担。要对抗真实自动化就选 `external`，但要接受访客 IP 会交给第三方端点 —— 所以它是管理员显式选择才启用的。

## 图片题为什么不用系统字体

图片由 sharp 在本机用**矢量笔画路径**绘制，不联网、不读取系统字体。

用 SVG `<text>` 的话，libvips 的 rsvg 确实带 freetype/fontconfig，但**字体是操作系统的东西**：精简镜像（alpine-slim、distroless）里一个字体都没有，`<text>` 会画成空白图 —— 用户看到一张干净的图，验证码永远答不对，注册这条路直接堵死，而且只在部分机器上复现。

实测（Node 22，本机 60 张）：190×64 PNG 单张 5.3–6.8KB，绘制 p50 约 4.3ms、p95 约 7.6ms。

## 三条硬规则（`math` 与 `image` 共用）

1. **一次一题**：一个 `sessionId` 只能验一次，消费是仓储层的一条原子 UPDATE。
2. **先消费再比对**：答错也把这道题烧掉。否则攻击者可以拿同一道题把候选答案全试一遍。
3. **答错不透露细节**：不存在 / 已用过 / 已过期 / 答案错，四种情况同一个错误码同一句文案（`CAPTCHA_INVALID`，400）。

两种模式共用同一套仓储与 `verify`，也共用出题限流 `CAPTCHA_GENERATE_RATE_LIMIT_*`（默认 10 次 / 5 分钟 / 来源地址）—— 分开限流等于给「一条路打满就换另一条」留口子。

## 外部验证：预设只填三项，其余全部可改，不绑定厂商

选 Cloudflare Turnstile / hCaptcha / Google reCAPTCHA 只是把三个值填成推荐值：

| 键 | 含义 |
|---|---|
| `EXTERNAL_CAPTCHA_PRESET` | 预设名，`custom` 表示三项全部自己给 |
| `EXTERNAL_CAPTCHA_SITE_KEY` | 站点标识，会出现在注册/登录页，属公开值 |
| `EXTERNAL_CAPTCHA_SECRET` | 校验密钥，只在服务端用，加密入库、脱敏回传 |
| `EXTERNAL_CAPTCHA_VERIFY_URL` | 服务端校验地址（可改成自建中转或国内可达地址） |
| `EXTERNAL_CAPTCHA_SCRIPT_URL` | 前端脚本地址（受 CSP 约束时要加进 `script-src`） |
| `EXTERNAL_CAPTCHA_GLOBAL_NAME` | 脚本挂到 `window` 上的对象名 |

校验只依赖这类服务的共同形状：**表单 POST（`secret` + `response` + `sitekey` + `remoteip`）→ 响应里一个布尔 `success`**。

需要厂商请求签名的服务（腾讯天御、阿里云人机验证、网易易盾、GeeTest v4）不符合这一形状，未内置 —— 不预先塞无法验证的代码，扩展位写在 `src/account/externalCaptcha.ts` 的注释里。

## 失败语义：绝不静默放行

| 情况 | 结果 |
|---|---|
| 用户答错 / token 缺失或过期 | **400 `CAPTCHA_INVALID`**，换一道即可 |
| 校验端点不可达 / 超时（默认 5s）/ 非 2xx / 响应不是 JSON | **502 `CAPTCHA_UNAVAILABLE`** |
| 开关开了但校验能力未接入 | 同样 502，不会退化成「当作通过」 |

两类错误码刻意分开：后者是「本站验不了」，管理员要去看配置；混在一起会把它当成「用户填错」。

`EXTERNAL_CAPTCHA_SECRET` 与 `SMTP_PASS` 同等待遇：AES-256-GCM 加密入库、管理端只回 `<KEY>_SET` 标志、公开端点不下发，留空保存不会清空已存密钥。

## SSRF 边界

`verifyUrl` 是管理员可配项，等于让服务器按管理员给的地址发一次请求。协议锁死在 http/https（挡掉 `file:` / `gopher:` 之类），但**刻意不拦内网地址** —— 「指向自建/内网校验服务」正是这项能力存在的理由之一，能配到管理面板的人本就有这台机器的配置权。
