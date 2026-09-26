/**
 * authlib-injector 的 `/.well-known/authlib-injector` 元数据。
 *
 * 存在的首要理由：**HMCL 添加外置登录服务器时会探测这个端点**，
 * 读到 `serverName` 才会用站点标题给服务器命名 —— 否则名称输入框
 * 原样填成 URL（用户在域名服务器上看到的正是这个现象）。
 * 端点同时挂在站点根与 `/api/yggdrasil` 前缀下，两种地址填法都能命中。
 *
 * 字段名跟随 authlib-injector 的事实标准（全小写的 openregistration 等），
 * 不做大写化「修正」：启动器按这些键解析。
 */

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
  links: {
    homepage: string;
    register: string;
    profile: string;
    password: string;
    user_page: string;
  };
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
    links: {
      homepage: `${site}/`,
      register: `${site}/#/register`,
      profile: `${site}/#/profile`,
      password: `${site}/#/forgot-password`,
      user_page: `${site}/#/profile`,
    },
    serverName: input.serverName,
    features: ['legacy_api'],
  };
}
