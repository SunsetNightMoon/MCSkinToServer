import { useState } from 'react';
import { Dropdown, Form, Input, message, Radio } from 'antd';
import { CheckOutlined, GlobalOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
// 密码长度口径：与后端（8-128 位）保持一致，见 utils/passwordPolicy.ts 的说明
import { MIN_PASSWORD_LENGTH } from '../../utils/passwordPolicy';

interface SetupData {
  siteName: string;
  dbType: 'sqlite' | 'postgresql';
  dbHost?: string;
  dbPort?: number;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  redisEnabled: boolean;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  mailHost: string;
  mailPort: number;
  mailUser: string;
  mailPass: string;
  mailFrom: string;
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export default function SetupWizard() {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [completed, setCompleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const [testingDb, setTestingDb] = useState(false);
  const [testingMail, setTestingMail] = useState(false);
  const [testingRedis, setTestingRedis] = useState(false);
  const [data, setData] = useState<SetupData>({
    siteName: '',
    dbType: 'sqlite',
    redisEnabled: false,
    redisHost: 'localhost',
    redisPort: 6379,
    redisPassword: '',
    mailHost: 'smtp.163.com',
    mailPort: 465,
    mailUser: '',
    mailPass: '',
    mailFrom: '',
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [form] = Form.useForm();

  const steps = [
    { number: 1, title: t('setup.steps.welcome') },
    { number: 2, title: t('setup.steps.site') },
    { number: 3, title: t('setup.steps.db') },
    { number: 4, title: t('setup.steps.redis') },
    { number: 5, title: t('setup.steps.email') },
    { number: 6, title: t('setup.steps.admin') },
    { number: 7, title: t('setup.steps.confirm') },
  ];

  const goNext = () => {
    const fieldsToValidate: string[] = [];
    if (step === 1) {
      setStep(2);
      setAnimKey(k => k + 1);
      return;
    }
    if (step === 2) fieldsToValidate.push('siteName');
    if (step === 3) {
      if (data.dbType === 'postgresql') {
        fieldsToValidate.push('dbHost', 'dbPort', 'dbName', 'dbUser', 'dbPassword');
      } else {
        setStep(4);
        setAnimKey(k => k + 1);
        return;
      }
    }
    if (step === 4) {
      setStep(5);
      setAnimKey(k => k + 1);
      return;
    }
    if (step === 5) {
      fieldsToValidate.push('mailHost', 'mailPort', 'mailUser', 'mailPass', 'mailFrom');
    }
    if (step === 6) {
      fieldsToValidate.push('username', 'email', 'password', 'confirmPassword');
    }

    if (fieldsToValidate.length > 0) {
      form.validateFields(fieldsToValidate).then((values) => {
        setData((prev) => ({ ...prev, ...values }));
        setStep(step + 1);
        setAnimKey(k => k + 1);
      }).catch(() => {});
    } else {
      setStep(step + 1);
      setAnimKey(k => k + 1);
    }
  };

  const goBack = () => {
    if (step > 1) {
      setStep(step - 1);
      setAnimKey(k => k + 1);
    }
  };

  const handleTestDb = async () => {
    const values = form.getFieldsValue();
    setTestingDb(true);
    try {
      const res = await fetch('/api/setup/test-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Language': i18n.language },
        body: JSON.stringify({
          db_type: data.dbType,
          db_host: values.dbHost || data.dbHost,
          db_port: values.dbPort || data.dbPort,
          db_name: values.dbName || data.dbName,
          db_user: values.dbUser || data.dbUser,
          db_password: values.dbPassword || data.dbPassword,
        }),
      });
      const body = await res.json().catch(() => ({ success: false, message: t('setup.unknownError') }));
      if (body.success) {
        message.success(body.message);
      } else {
        message.error(body.message);
      }
    } catch (e: any) {
      message.error(e.message || t('setup.testFailed'));
    } finally {
      setTestingDb(false);
    }
  };

  const handleTestEmail = async () => {
    const values = form.getFieldsValue();
    setTestingMail(true);
    try {
      const res = await fetch('/api/setup/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Language': i18n.language },
        body: JSON.stringify({
          mail_host: values.mailHost || data.mailHost,
          mail_port: values.mailPort || data.mailPort,
          mail_user: values.mailUser || data.mailUser,
          mail_pass: values.mailPass || data.mailPass,
          mail_from: values.mailFrom || data.mailFrom,
        }),
      });
      const body = await res.json().catch(() => ({ success: false, message: t('setup.unknownError') }));
      if (body.success) {
        message.success(body.message);
      } else {
        message.error(body.message);
      }
    } catch (e: any) {
      message.error(e.message || t('setup.testFailed'));
    } finally {
      setTestingMail(false);
    }
  };

  const handleTestRedis = async () => {
    const values = form.getFieldsValue();
    setTestingRedis(true);
    try {
      const res = await fetch('/api/setup/test-redis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Language': i18n.language },
        body: JSON.stringify({
          redis_host: values.redisHost || data.redisHost,
          redis_port: values.redisPort || data.redisPort,
          redis_password: values.redisPassword || data.redisPassword,
        }),
      });
      const body = await res.json().catch(() => ({ success: false, message: t('setup.unknownError') }));
      if (body.success) {
        message.success(body.message);
      } else {
        message.error(body.message);
      }
    } catch (e: any) {
      message.error(e.message || t('setup.testFailed'));
    } finally {
      setTestingRedis(false);
    }
  };

  const handleFinish = () => {
    setLoading(true);
    const payload: any = {
      site_name: data.siteName,
      db_type: data.dbType,
      redis_enabled: data.redisEnabled,
      mail_host: data.mailHost,
      mail_port: data.mailPort,
      mail_user: data.mailUser,
      mail_pass: data.mailPass,
      mail_from: data.mailFrom,
      admin_email: data.email,
      admin_password: data.password,
      admin_username: data.username,
    };
    if (data.dbType === 'postgresql') {
      payload.db_host = data.dbHost;
      payload.db_port = data.dbPort;
      payload.db_name = data.dbName;
      payload.db_user = data.dbUser;
      payload.db_password = data.dbPassword;
    }
    if (data.redisEnabled) {
      payload.redis_host = data.redisHost;
      payload.redis_port = data.redisPort;
      payload.redis_password = data.redisPassword;
    }
    fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Language': i18n.language },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({ success: false, error: t('setup.unknownError') }));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!body.success) throw new Error(body.error || t('setup.setupFailed'));
        setCompleted(true);
        message.success(t('setup.installComplete'));
      })
      .catch((err: Error) => {
        message.error(err.message || t('setup.installFailed'));
      })
      .finally(() => setLoading(false));
  };

  if (completed) {
    return (
      <div style={styles.page}>
        <div style={styles.topBar}>
          <div style={styles.stepItemActive}>
            <CheckOutlined style={{ marginRight: 6, fontSize: 12 }} />
            {t('setup.steps.confirm')}
          </div>
        </div>
        <div style={styles.content}>
          <h1 style={styles.title}>{t('setup.installComplete')}</h1>
          <p style={styles.subtitle}>{t('setup.installCompleteDesc')}</p>
          <div style={{ flex: 1 }} />
          <div style={styles.actionArea}>
            <button
              style={styles.primaryButton}
              onClick={() => (window.location.hash = '#/login')}
            >
              {t('setup.goToLogin')}
            </button>
          </div>
        </div>
        <div style={styles.bottomBar} />
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <style>{`
        @keyframes fadeIn {
          from { opacity:0; transform: translateY(8px); }
          to   { opacity:1; transform: translateY(0); }
        }
        .setup-fade-in {
          animation: fadeIn 0.30s ease-out both;
        }
        .ant-form-item-label > label {
          color: #ffffff !important;
          font-size: 15px !important;
          font-weight: 500 !important;
        }
        .ant-form-item-label > label.ant-form-item-required::before {
          color: #ff7875 !important;
        }
        .ant-input::placeholder,
        .ant-input-password input::placeholder {
          color: rgba(255,255,255,0.4) !important;
        }
        .ant-input-affix-wrapper {
          background: rgba(255,255,255,0.12) !important;
          border: 1px solid rgba(255,255,255,0.25) !important;
        }
        .ant-input-affix-wrapper .ant-input-suffix {
          color: rgba(255,255,255,0.6) !important;
        }
        .ant-select-selector {
          background: rgba(255,255,255,0.12) !important;
          border: 1px solid rgba(255,255,255,0.25) !important;
          color: #fff !important;
        }
        .ant-select-arrow {
          color: rgba(255,255,255,0.6) !important;
        }
        .ant-radio-wrapper {
          color: #ffffff !important;
        }
        .ant-radio-inner {
          border-color: rgba(255,255,255,0.4) !important;
        }
        .ant-radio-checked .ant-radio-inner {
          border-color: #0078d7 !important;
          background: #0078d7 !important;
        }
        .ant-dropdown-menu {
          border-radius: 0 !important;
          padding: 0 !important;
        }
        .ant-dropdown-menu-item {
          border-radius: 0 !important;
        }
        .ant-dropdown-menu-item:hover {
          background: #0078d7 !important;
        }
        .ant-dropdown-menu-item:hover span {
          color: #fff !important;
        }
      `}</style>

      {/* 顶部导航条 */}
      <div style={styles.topBar}>
        <div style={{ display: 'flex', gap: 0 }}>
          {steps.map((s) => (
            <div
              key={s.number}
              style={step === s.number ? styles.stepItemActive : styles.stepItem}
            >
              {step > s.number ? (
                <><CheckOutlined style={{ marginRight: 6, fontSize: 12 }} />{s.title}</>
              ) : (
                s.title
              )}
              {step === s.number && <div style={styles.stepIndicator} />}
            </div>
          ))}
        </div>
      </div>

      {/* 主内容 */}
      <div style={styles.content}>
        {/* 步骤内容（带过渡动画） */}
        <div key={animKey} className="setup-fade-in" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>

        {/* 步骤1：欢迎 */}
        {step === 1 && (
          <>
            <h1 style={styles.title}>{t('setup.welcome')}</h1>
            <p style={styles.subtitle} dangerouslySetInnerHTML={{ __html: t('setup.welcomeDesc') }} />
          </>
        )}

        {/* 步骤2：站点配置 */}
        {step === 2 && (
          <>
            <h1 style={styles.title}>{t('setup.siteConfig')}</h1>
            <Form form={form} layout="vertical" initialValues={{ siteName: data.siteName }} style={{ width: '100%' }}>
              <Form.Item
                label={t('setup.siteName')}
                name="siteName"
                rules={[{ required: true, message: t('setup.validation.siteNameRequired') }]}
                style={{ marginBottom: 32 }}
              >
                <Input placeholder={t('setup.siteNamePlaceholder')} size="large" style={styles.input} />
              </Form.Item>
            </Form>
          </>
        )}

        {/* 步骤3：数据库设置 */}
        {step === 3 && (
          <>
            <h1 style={styles.title}>{t('setup.dbConfig')}</h1>
            <Form form={form} layout="vertical" initialValues={{ dbType: data.dbType, dbPort: data.dbPort || 5432 }} style={{ width: '100%' }}>
              <Form.Item label={t('setup.dbType')} style={{ marginBottom: 32 }}>
                <Radio.Group
                  value={data.dbType}
                  onChange={(e) => setData((prev) => ({ ...prev, dbType: e.target.value }))}
                  style={{ color: '#fff' }}
                >
                  <Radio value="sqlite" style={{ color: '#fff', marginRight: 32 }}>{t('setup.sqlite')}</Radio>
                  <Radio value="postgresql" style={{ color: '#fff' }}>{t('setup.postgresql')}</Radio>
                </Radio.Group>
              </Form.Item>

              {data.dbType === 'postgresql' && (
                <>
                  <Form.Item
                    label={t('setup.dbHost')}
                    name="dbHost"
                    rules={[{ required: true, message: t('setup.validation.dbHostRequired') }]}
                    style={{ marginBottom: 20 }}
                  >
                    <Input placeholder={t('setup.dbHostPlaceholder')} size="large" style={styles.input} />
                  </Form.Item>
                  <Form.Item
                    label={t('setup.dbPort')}
                    name="dbPort"
                    rules={[{ required: true, message: t('setup.validation.dbPortRequired') }]}
                    style={{ marginBottom: 20 }}
                  >
                    <Input type="number" placeholder={t('setup.dbPortPlaceholder')} size="large" style={styles.input} />
                  </Form.Item>
                  <Form.Item
                    label={t('setup.dbName')}
                    name="dbName"
                    rules={[{ required: true, message: t('setup.validation.dbNameRequired') }]}
                    style={{ marginBottom: 20 }}
                  >
                    <Input placeholder={t('setup.dbNamePlaceholder')} size="large" style={styles.input} />
                  </Form.Item>
                  <Form.Item
                    label={t('setup.dbUser')}
                    name="dbUser"
                    rules={[{ required: true, message: t('setup.validation.dbUserRequired') }]}
                    style={{ marginBottom: 20 }}
                  >
                    <Input placeholder={t('setup.dbUserPlaceholder')} size="large" style={styles.input} />
                  </Form.Item>
                  <Form.Item
                    label={t('setup.dbPassword')}
                    name="dbPassword"
                    rules={[{ required: true, message: t('setup.validation.dbPasswordRequired') }]}
                    style={{ marginBottom: 20 }}
                  >
                    <Input.Password placeholder={t('setup.dbPasswordPlaceholder')} size="large" style={styles.input} />
                  </Form.Item>
                  <div style={{ marginBottom: 20 }}>
                    <button
                      type="button"
                      style={styles.testButton}
                      onClick={handleTestDb}
                      disabled={testingDb}
                    >
                      <ThunderboltOutlined style={{ marginRight: 6, fontSize: 12 }} />
                      {testingDb ? t('setup.testing') : t('setup.testConnection')}
                    </button>
                  </div>
                </>
            )}

              {data.dbType === 'sqlite' && (
                <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
                  {t('setup.sqliteHint')}
                </p>
              )}
            </Form>
          </>
        )}

        {/* 步骤4：Redis 缓存设置 */}
        {step === 4 && (
          <>
            <h1 style={styles.title}>{t('setup.redisTitle')}</h1>
            <p style={styles.subtitle}>{t('setup.redisDesc')}</p>
            <Form form={form} layout="vertical" initialValues={{
              redisEnabled: data.redisEnabled,
              redisHost: data.redisHost,
              redisPort: data.redisPort,
              redisPassword: data.redisPassword,
            }} style={{ width: '100%' }}>
              <Form.Item label={t('setup.redisEnable')} style={{ marginBottom: 24 }}>
                <Radio.Group
                  value={data.redisEnabled}
                  onChange={(e) => setData((prev) => ({ ...prev, redisEnabled: e.target.value }))}
                  style={{ color: '#fff' }}
                >
                  <Radio value={true} style={{ color: '#fff', marginRight: 32 }}>{t('setup.redisEnableYes')}</Radio>
                  <Radio value={false} style={{ color: '#fff' }}>{t('setup.redisEnableNo')}</Radio>
                </Radio.Group>
              </Form.Item>

              {data.redisEnabled && (
                <>
                  <Form.Item
                    label={t('setup.redisHost')}
                    name="redisHost"
                    rules={[{ required: true, message: t('setup.validation.redisHostRequired') }]}
                    style={{ marginBottom: 20 }}
                  >
                    <Input placeholder={t('setup.redisHostPlaceholder')} size="large" style={styles.input} />
                  </Form.Item>
                  <Form.Item
                    label={t('setup.redisPort')}
                    name="redisPort"
                    rules={[{ required: true, message: t('setup.validation.redisPortRequired') }]}
                    style={{ marginBottom: 20 }}
                  >
                    <Input type="number" placeholder={t('setup.redisPortPlaceholder')} size="large" style={styles.input} />
                  </Form.Item>
                  <Form.Item
                    label={t('setup.redisPassword')}
                    name="redisPassword"
                    style={{ marginBottom: 20 }}
                  >
                    <Input.Password placeholder={t('setup.redisPasswordPlaceholder')} size="large" style={styles.input} />
                  </Form.Item>
                  <div style={{ marginBottom: 20 }}>
                    <button
                      type="button"
                      style={styles.testButton}
                      onClick={handleTestRedis}
                      disabled={testingRedis}
                    >
                      <ThunderboltOutlined style={{ marginRight: 6, fontSize: 12 }} />
                      {testingRedis ? t('setup.testing') : t('setup.testConnection')}
                    </button>
                  </div>
                </>
            )}

              {!data.redisEnabled && (
                <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
                  {t('setup.redisNoHint')}
                </p>
              )}
            </Form>
          </>
        )}

        {/* 步骤5：邮箱设置 */}
        {step === 5 && (
          <>
            <h1 style={styles.title}>{t('setup.mailTitle')}</h1>
            <p style={styles.subtitle}>{t('setup.mailDesc')}</p>
            <Form form={form} layout="vertical" initialValues={{
              mailHost: data.mailHost,
              mailPort: data.mailPort,
              mailFrom: data.mailFrom,
            }} style={{ width: '100%' }}>
              <Form.Item
                label={t('setup.smtpServer')}
                name="mailHost"
                rules={[{ required: true, message: t('setup.validation.mailHostRequired') }]}
                style={{ marginBottom: 20 }}
              >
                <Input placeholder={t('setup.smtpServerPlaceholder')} size="large" style={styles.input} />
              </Form.Item>
              <Form.Item
                label={t('setup.smtpPort')}
                name="mailPort"
                rules={[{ required: true, message: t('setup.validation.mailPortRequired') }]}
                style={{ marginBottom: 20 }}
              >
                <Input type="number" placeholder={t('setup.smtpPortPlaceholder')} size="large" style={styles.input} />
              </Form.Item>
              <Form.Item
                label={t('setup.senderEmail')}
                name="mailFrom"
                rules={[
                  { required: true, message: t('setup.validation.mailFromRequired') },
                  { type: 'email', message: t('setup.validation.emailInvalid') },
                ]}
                style={{ marginBottom: 20 }}
              >
                <Input placeholder={t('setup.senderEmailPlaceholder')} size="large" style={styles.input} />
              </Form.Item>
              <Form.Item
                label={t('setup.smtpUser')}
                name="mailUser"
                rules={[{ required: true, message: t('setup.validation.mailUserRequired') }]}
                style={{ marginBottom: 20 }}
              >
                <Input placeholder={t('setup.smtpUserPlaceholder')} size="large" style={styles.input} />
              </Form.Item>
              <Form.Item
                label={t('setup.smtpPass')}
                name="mailPass"
                rules={[{ required: true, message: t('setup.validation.mailPassRequired') }]}
                style={{ marginBottom: 20 }}
              >
                <Input.Password placeholder={t('setup.smtpPassPlaceholder')} size="large" style={styles.input} />
              </Form.Item>
              <div style={{ marginBottom: 20 }}>
                <button
                  type="button"
                  style={styles.testButton}
                  onClick={handleTestEmail}
                  disabled={testingMail}
                >
                  <ThunderboltOutlined style={{ marginRight: 6, fontSize: 12 }} />
                  {testingMail ? t('setup.testing') : t('setup.testConnection')}
                </button>
              </div>
            </Form>
          </>
        )}

        {/* 步骤6：管理员账户 */}
        {step === 6 && (
          <>
            <h1 style={styles.title}>{t('setup.adminTitle')}</h1>
            <Form form={form} layout="vertical" style={{ width: '100%' }}>
              <Form.Item
                label={t('setup.username')}
                name="username"
                rules={[
                  { required: true, message: t('setup.validation.usernameRequired') },
                  { min: 3, message: t('setup.validation.usernameMin') },
                  { pattern: /^[a-zA-Z0-9_]+$/, message: t('setup.validation.usernamePattern') },
                ]}
                style={{ marginBottom: 20 }}
              >
                <Input placeholder={t('setup.usernamePlaceholder')} size="large" style={styles.input} />
              </Form.Item>

              <Form.Item
                label={t('setup.email')}
                name="email"
                rules={[
                  { required: true, message: t('setup.validation.emailRequired') },
                  { type: 'email', message: t('setup.validation.emailInvalid') },
                ]}
                style={{ marginBottom: 20 }}
              >
                <Input placeholder={t('setup.emailPlaceholder')} size="large" style={styles.input} />
              </Form.Item>

              <Form.Item
                label={t('setup.password')}
                name="password"
                rules={[
                  { required: true, message: t('setup.validation.passwordRequired') },
                  { min: MIN_PASSWORD_LENGTH, message: t('setup.validation.passwordMin') },
                ]}
                style={{ marginBottom: 20 }}
              >
                <Input.Password placeholder={t('setup.passwordPlaceholder')} size="large" style={styles.input} />
              </Form.Item>

              <Form.Item
                label={t('setup.confirmPassword')}
                name="confirmPassword"
                rules={[
                  { required: true, message: t('setup.validation.confirmPasswordRequired') },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('password') === value) return Promise.resolve();
                      return Promise.reject(new Error(t('setup.validation.passwordMismatch')));
                    },
                  }),
                ]}
                style={{ marginBottom: 20 }}
              >
                <Input.Password placeholder={t('setup.confirmPasswordPlaceholder')} size="large" style={styles.input} />
              </Form.Item>
            </Form>
          </>
        )}

        {/* 步骤7：确认 */}
        {step === 7 && (
          <>
            <h1 style={styles.title}>{t('setup.confirmTitle')}</h1>
            <p style={styles.subtitle}>{t('setup.confirmDesc')}</p>
            <div style={styles.confirmBox}>
              <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.siteNameLabel')}</span><span style={styles.confirmValue}>{data.siteName}</span></div>
              <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.dbTypeLabel')}</span><span style={styles.confirmValue}>{data.dbType === 'sqlite' ? t('setup.sqlite') : t('setup.postgresql')}</span></div>
              {data.dbType === 'postgresql' && (
                <>
                  <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.dbHostLabel')}</span><span style={styles.confirmValue}>{data.dbHost}</span></div>
                  <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.dbNameLabel')}</span><span style={styles.confirmValue}>{data.dbName}</span></div>
                </>
              )}
              <div style={{ height: 12 }} />
              <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.redisLabel')}</span><span style={styles.confirmValue}>{data.redisEnabled ? `${t('setup.redisEnableYes')} (${data.redisHost}:${data.redisPort})` : t('setup.redisEnableNo')}</span></div>
              <div style={{ height: 12 }} />
              <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.smtpServerLabel')}</span><span style={styles.confirmValue}>{data.mailHost}:{data.mailPort}</span></div>
              <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.senderEmailLabel')}</span><span style={styles.confirmValue}>{data.mailFrom}</span></div>
              <div style={{ height: 12 }} />
              <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.adminUserLabel')}</span><span style={styles.confirmValue}>{data.username}</span></div>
              <div style={styles.confirmRow}><span style={styles.confirmLabel}>{t('setup.adminEmailLabel')}</span><span style={styles.confirmValue}>{data.email}</span></div>
            </div>
          </>
        )}

        {/* 关闭动画包裹层 */}
        </div>

        <div style={{ flex: 1 }} />
        <div style={styles.actionArea}>
          {step > 1 && (
            <button style={styles.secondaryButton} onClick={goBack}>
              {t('setup.prevStep')}
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step < 7 ? (
            <button style={styles.primaryButton} onClick={goNext} disabled={loading}>
              {t('setup.nextStep')} <RightOutlined style={{ marginLeft: 6, fontSize: 12 }} />
            </button>
          ) : (
            <button style={styles.primaryButton} onClick={handleFinish} disabled={loading}>
              {loading ? t('setup.installing') : t('setup.startInstall')}
            </button>
          )}
        </div>
      </div>

      {/* 底部黑边 + 语言切换 */}
      <div style={styles.bottomBar}>
        <Dropdown
          placement="topRight"
          overlayStyle={{ minWidth: 140 }}
          menu={{
            style: { background: '#2a2a2a', border: '1px solid #444', borderRadius: 0 },
            items: [
              { key: 'SCH', label: <span style={{ color: '#fff' }}>{t('setup.lang.SCH', '简体中文')}</span> },
              { key: 'TCH', label: <span style={{ color: '#fff' }}>{t('setup.lang.TCH', '繁體中文')}</span> },
              { key: 'EN', label: <span style={{ color: '#fff' }}>{t('setup.lang.EN', 'English')}</span> },
              { key: 'JP', label: <span style={{ color: '#fff' }}>{t('setup.lang.JP', '日本語')}</span> },
            ],
            onClick: ({ key }) => {
              i18n.changeLanguage(key);
            },
          }}
        >
          <button
            type="button"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '8px 12px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <GlobalOutlined style={{ color: '#888', fontSize: 16 }} />
          </button>
        </Dropdown>
      </div>
    </div>
  );
}

/* ─── Win10 OOBE 风格样式 ─── */

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#003366',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'Segoe UI, system-ui, -apple-system, sans-serif',
  },

  topBar: {
    background: '#1a1a1a',
    height: 48,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    borderBottom: '1px solid #333',
    flexShrink: 0,
  },

  stepItem: {
    padding: '0 20px',
    color: '#888',
    fontSize: 13,
    position: 'relative',
    height: 48,
    display: 'flex',
    alignItems: 'center',
    cursor: 'default',
  },

  stepItemActive: {
    padding: '0 20px',
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    position: 'relative',
    height: 48,
    display: 'flex',
    alignItems: 'center',
    cursor: 'default',
  },

  stepIndicator: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    background: '#0078d7',
  },

  content: {
    flex: 1,
    maxWidth: 640,
    width: '100%',
    margin: '0 auto',
    padding: '80px 40px 0',
    display: 'flex',
    flexDirection: 'column',
  },

  title: {
    fontSize: 32,
    fontWeight: 300,
    color: '#ffffff',
    marginBottom: 16,
    lineHeight: 1.3,
    letterSpacing: '-0.5px',
  },

  subtitle: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.65)',
    fontWeight: 400,
    marginBottom: 48,
    lineHeight: 1.6,
  },

  input: {
    background: 'rgba(255,255,255,0.12)',
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: 2,
    color: '#fff',
    fontSize: 16,
    height: 44,
    padding: '0 16px',
  },

  confirmBox: {
    background: 'rgba(255,255,255,0.06)',
    borderRadius: 4,
    padding: '24px 28px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },

  confirmRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  confirmLabel: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
  },

  confirmValue: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 500,
  },

  actionArea: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '40px 0 32px',
    width: '100%',
  },

  bottomBar: {
    background: '#1a1a1a',
    height: 48,
    flexShrink: 0,
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    padding: '0 20px',
  },

  primaryButton: {
    background: '#0078d7',
    color: '#fff',
    border: 'none',
    borderRadius: 2,
    padding: '10px 28px',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 0.2s',
    display: 'inline-flex',
    alignItems: 'center',
  },

  secondaryButton: {
    background: 'transparent',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.35)',
    borderRadius: 2,
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },

  testButton: {
    background: 'rgba(0,120,215,0.15)',
    color: '#4db8ff',
    border: '1px solid rgba(0,120,215,0.4)',
    borderRadius: 2,
    padding: '8px 18px',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
    display: 'inline-flex',
    alignItems: 'center',
  },
};
