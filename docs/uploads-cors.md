# 素材跨源读取

`/uploads` 的纹理默认**只对同源与站点自身来源**开放跨源读取。此前这里写死 `Access-Control-Allow-Origin: *`，等于允许任何站点的脚本把本站素材读进 canvas 原样抠走。

## 它管什么，不管什么

`Access-Control-Allow-Origin` 只决定**别的站点的 JavaScript 能不能把这张图读进 canvas**（`toDataURL` / `getImageData`），也就是「把本站素材抠走、二次合成」这条路。

它**不防热链**：`<img src="https://本站/uploads/…">` 是普通子资源请求，浏览器对图片显示不做 CORS 检查 —— 有没有这个头，别人嵌图照样正常显示，回源带宽一分不少。

要防热链请看文末的 [Referer 配方](#referer-配方)。

## 放行规则

| 请求来源 | 白名单留空（默认） | 白名单含该来源 | 白名单填 `*` |
|---|---|---|---|
| 无 `Origin`（直接打开、`<img>` 热链、启动器取纹理） | 200，不发 ACAO | 200，不发 ACAO | 200，不发 ACAO |
| 同源（`Origin` == 请求自身 `Host`） | 回显该来源 | 回显该来源 | `*` |
| 站点自身来源（`BASE_URL` 解析出的 origin） | 回显该来源 | 回显该来源 | `*` |
| 其它来源 | **不发 ACAO** | 回显该来源 | `*` |

- 无 `Origin` 的请求在判白名单之前就放行：这类请求本来就不需要 CORS 头，`*` 也不会给它补一个。

- 同源判定用请求自己的 `Host`，**不依赖 `BASE_URL` 是否配置** —— 管理员没填站点根时，自家头像与 3D 预览不该因此图裂。
- 命中才回显，且回显的是**归一化后的值**，绝不把请求头原文写进响应。

## 站点设置 `UPLOAD_CORS_ORIGINS`

逗号或换行分隔的来源列表，只写域名按 `https://` 补齐。

- 留空 = 最严（只放行同源与站点自身来源）；填 `*` = 退回全放行。
- 认不出的项**逐项丢弃**，不会让整条白名单失效。分隔符刻意不含空格：含空格的话管理员手滑写的 `not a url` 会被拆成 `https://not`、`https://a`、`https://url` 三个看着合法的来源 —— 那是静默放宽，不是丢垃圾项。

**素材挂在独立图床 / CDN 域名下时，必须把页面所在来源写进白名单**，否则 `crossOrigin="anonymous"` 的纹理会直接加载失败（不只是画布被污染）。

## CDN 与反代必须尊重 `Vary: Origin`

`/uploads` 的每个响应**无论命中与否都带 `Vary: Origin`**。

回显具体来源意味着同一 URL 的响应随来源变化，共享缓存若不按 `Origin` 分键，就会把 A 来源的响应缓存后发给 B 来源，表现为「我这边好、他那边图裂」。做不到按来源分键时三选一：

1. 素材与页面同源（最省事，根本不需要 CORS）；
2. 给 `/uploads` 关掉 CDN 缓存；
3. 白名单填 `*` 退回全放行。

## Referer 配方

热链只能靠网关 / CDN 按 Referer 判定，本仓库刻意不实现 —— 每台主机的策略不同，属个例。nginx 示例：

```nginx
location ~ ^/uploads/ {
  # 无 Referer 必须放行：直接打开、隐私模式、Referrer-Policy 降级都没有 Referer
  valid_referers none blocked server_names ~\.example\.com$;
  if ($invalid_referer) { return 403; }
  proxy_pass http://mcsts_backend;   # 或 alias 到本地目录
}
```

三条边界：

1. Referer 只是请求头，非浏览器客户端可以随便填，**挡君子不挡小人**。
2. Yggdrasil 客户端取纹理同样可能不带 Referer，规则要按 `location` 精确圈定，别把启动器一起挡了。
3. 要更硬就换签名 URL / 时效 token，那要改整条素材链路，不在静态目录这一层。
