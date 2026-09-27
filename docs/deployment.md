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
