# 生产部署要点

面向自部署者。安装与构建命令见 [README](../README.md#构建与生产部署)，本文只讲**上线时容易踩的部分**。环境变量完整清单见 [`.env.example`](../.env.example)，前端变量见 `web/.env.example`。

## 1. 反向代理（Nginx / OpenResty）

```nginx
root /path/to/MCSTS/web/dist;
location / { try_files $uri $uri/ /index.html; }   # HashRouter 文档入口是 /

# 启动器填裸域名时靠 ALI 头发现 API 地址：根路径由 SPA 接管，后端的响应头到不了这里
location = / { add_header X-Authlib-Injector-API-Location /api/yggdrasil always; try_files /index.html =404; }

# 业务接口 + Yggdrasil + 纹理 + ALI 风格元数据
location ~ ^/(api|uploads|\.well-known)/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**反代后必须设 `TRUST_PROXY=1`**（或写反代层数）。不设的话所有按 IP 的限流会把全部用户算进同一个桶 —— 表现为「一部分用户莫名其妙被 429」。

## 2. 主密钥 `MCSTS_SECRET`

生产必配，≥16 字符。它是站点设置里凭据类键（`SMTP_PASS`、`EXTERNAL_CAPTCHA_SECRET`）的 AES-256-GCM 加密主密钥。

- 未设置 → 这些值按明文落库：功能可用，但数据库备份或只读副本会把它们带出去。
- **补上主密钥不会追溯加密历史明文**：`system_settings` 里已有的值仍是明文，要进后台把 `SMTP_PASS`、`EXTERNAL_CAPTCHA_SECRET` **各自重新保存一次**才会落库成密文。
- 轮换后旧密文无法解密，会明确报「密文解密失败」而不是静默返回空值 —— 这是刻意设计，换密钥前先把凭据重存一遍。

## 3. 启动器（HMCL 等）怎么填

- **认证服务器地址填 `https://<域名>/api/yggdrasil` 最稳**；配了上面的 ALI 头之后，裸域名也能被解析。
- 站点显示名来自元数据的 `meta.serverName`（即站点标题）。**改标题后要在启动器账户页点刷新重取元数据**，否则看到的还是磁盘缓存里的旧名字。

## 4. 多实例与 Redis

多实例部署必须配 `REDIS_URL`，否则限流与缓存退化为「每实例各限一份」—— 同一个用户在 A 实例用完配额，到 B 实例又是满的。未配 Redis 时核心功能不受影响，只是自动降级为进程内存实现。

## 5. 密码哈希强度 `BCRYPT_COST`

缺省 10（OWASP 下限），钳制在 10-14；越界只钳制并打一条警告，不会让服务起不来。

- 调高后**存量账号在下次登录成功时自动重算**（cost 就写在哈希串里，那一刻明文正在手上），不必强制任何人改密码；调低不会降级已有哈希。
- 代价：bcryptjs 是纯 JS 实现，cost 每 +1 耗时约翻倍。实测（16 核）登录一次约从 80ms（cost 10）涨到 340ms（cost 12），低配 VPS 更慢。所以默认值不动，由管理员按自己的机器决定。
- 强度只有一个来源：注册、改密、安装向导三条写入路径共用同一个配置值。

## 6. 匿名端点限流

`POST /api/profiles/minecraft`（角色名 → UUID）匿名可用，按来源 IP 限流，缺省 60 次/分钟（`PROFILE_LOOKUP_RATE_LIMIT_MAX` / `_WINDOW_MS`）。不限流就等于允许无限速遍历全站角色名与 UUID；阈值再紧就会误伤进服时的正常客户端与共用出口地址（宿舍/机房 NAT），所以取宽松值。

验证码出题限流 `CAPTCHA_GENERATE_RATE_LIMIT_*`（默认 10 次 / 5 分钟 / 来源地址）由数学题与图片题共用。两套都受 `RATE_LIMIT_DISABLED` 总开关管。

## 7. 跨源与 CDN

素材跨源读取、`Vary: Origin` 与 CDN 缓存分键、以及热链（Referer）的处理见 [素材跨源读取](uploads-cors.md)。

## 8. 人机验证怎么配

四种模式的取舍、外部验证的「预设 + 全部可改」、以及 502 的语义见 [人机验证](human-verification.md)。

## 9. 登录限流按账号，不按提交的字符串

网页登录与启动器 `authenticate` / `signout` 的配额是**按账号**计的：一个账号的主邮箱和已验证的备用邮箱共用同一个 5 次/5 分钟窗口。按提交值计会让同账号拿到两份配额（撞库失败后换个地址接着试）。

解析不出账号时（地址不存在、跨列冲突、超长畸形值）回落到按提交值计 —— 随机邮箱的尝试各算各的，不会把拼错邮箱或用临时邮箱的人挤进同一个桶。

## 10. 启动配置自检

正常模式装配末尾会打一段 `[mcsts] 配置自检` 日志，逐项点名「能跑但缺了会出怪事」的配置：**只提示、不阻断启动**（这些项都有合法的缺省），全部合格时一个字都不打。当前覆盖：

| 项 | 缺了会看到什么 |
| --- | --- |
| `MCSTS_SECRET` | 站点设置里的凭据按明文落库；补上后**要重新保存**那两项才加密 |
| `TRUST_PROXY` | 在反代之后却没设 → 按来源 IP 的限流把全网算成一个桶，一部分用户莫名 429 |
| `BASE_URL`（后台设置） | 未声明 → 邮件里的验证/重置链接按触发请求的 Host 现场推导 |
| `RATE_LIMIT_DISABLED` | 限流整体关闭，只适合排障/压测的临时状态 |
| `SMTP_ALLOW_SELF_SIGNED` | 不校验 SMTP 证书，中间人可拿到邮件里的重置链接 |
| `MCSTS_PLUGIN_MIRROR` | 设置了但不是合法的 https 前缀 → 按未设置处理，插件导入仍直连 github.com |

判断依据只有环境变量、配置值与站点根是否已声明 —— 进程看不见网络链路，所以「是否真的在反代后面」这类问题写成条件句，由运维对照自己的部署取舍；确认不在反代之后的可以忽略那条，**但别为了消日志乱开 `TRUST_PROXY`**，那会让客户端伪造 `X-Forwarded-For` 绕过限流。

## 11. 直连 GitHub 不畅时，插件导入走镜像

面板「从 GitHub 导入」贴的地址只决定**装哪个仓库**；往哪儿发请求由部署侧的一个变量决定：

```ini
# 形态：把完整请求 URL 拼在前缀后面（gh-proxy 一类的通用转发）
MCSTS_PLUGIN_MIRROR=https://gh-proxy.com
# 实际发出：https://gh-proxy.com/https://api.github.com/repos/<owner>/<repo>/tags
```

- 只接受合法的 **https 绝对地址**；填错按未设置处理，并由上面的配置自检点名（导入会照旧直连 github.com，不会静悄悄）。
- 这个前缀必须**同时转发** `api.github.com`（取 tag、取清单）与 `raw.githubusercontent.com`（取文件），否则会卡在取文件或取清单那一步；失败文案里会带上实际请求的主机，据此判断镜像够不够。
- 私有仓库另外配 `MCSTS_GH_TOKEN`。
- 面板上粘「镜像前缀 + 完整 GitHub 地址」（`https://gh-proxy.com/https://github.com/o/r.git`）也认 —— 但它只是被拆回 `owner/repo`，**请求主机仍以这里的配置为准**。这样才不存在「超管账号被拿去探内网任意地址」的口子。
