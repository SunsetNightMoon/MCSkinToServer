/**
 * authlib-injector 的 `/.well-known/authlib-injector` 元数据。
 *
 * 注意：`X-Authlib-Injector-API-Location` 头 + API 根元数据里的 `meta.serverName`
 * 才是启动器（HMCL）给认证服务器命名的地方，本文件这个文档**不在启动器技术规范里**，
 * 保留它是为了兼容按该约定探测的第三方站点/工具，不要把它当成命名修复点。
 * 面向用户的链接与 API 根元数据共用 `buildInjectorLinks`，两处形态必须一致。
 *
 * 字段名跟随 authlib-injector 的事实标准（全小写的 openregistration 等），
 * 不做大写化「修正」：启动器按这些键解析。
 */

export interface AuthlibInjectorLinks {
  homepage: string;
  register: string;
  profile: string;
  password: string;
  user_page: string;
}

/** 站点根的 HashRouter 外链集合：API 根元数据与本文档共用 */
export function buildInjectorLinks(origin: string): AuthlibInjectorLinks {
  const site = origin.replace(/\/+$/, '');
  return {
    homepage: `${site}/`,
    register: `${site}/#/register`,
    profile: `${site}/#/profile`,
    password: `${site}/#/forgot-password`,
    user_page: `${site}/#/profile`,
  };
}

export interface AuthlibInjectorMetadata {
  github: string;
  /** 是否开放注册（跟随 ALLOW_REGISTRATION 设置） */
  openregistration: boolean;
  /** 定时任务开关：本站无排队/计划能力，恒 false */
  scheduleenabled: boolean;
  /** 是否允许非邮箱登录：本站账号体系以邮箱为锚，恒 false */
  non_email_login: boolean;
  /** 认证服务器根（启动器把端点路径拼在它后面） */
  root: string;
  links: AuthlibInjectorLinks;
  serverName: string;
  /** legacy_api = 提供 /api/profiles/minecraft 批量角色查询（本站确实提供） */
  features: string[];
}

export interface AuthlibInjectorMetaInput {
  /** 站点根（无尾斜杠），如 https://skin.example.com */
  origin: string;
  serverName: string;
  openRegistration: boolean;
  /** 项目主页（署名/开源仓库），默认指向 GitHub 仓库 */
  github?: string;
}

export function buildAuthlibInjectorMeta(
  input: AuthlibInjectorMetaInput,
): AuthlibInjectorMetadata {
  const site = input.origin.replace(/\/+$/, '');
  return {
    github: input.github ?? 'https://github.com/SunsetNightMoon/MCSkinToServer',
    openregistration: input.openRegistration,
    scheduleenabled: false,
    non_email_login: false,
    root: `${site}/api/yggdrasil`,
    // 前端是 HashRouter：路由页必须挂在 # 之后，直连路径会被静态托管 404
    links: buildInjectorLinks(site),
    serverName: input.serverName,
    features: ['legacy_api'],
  };
}
