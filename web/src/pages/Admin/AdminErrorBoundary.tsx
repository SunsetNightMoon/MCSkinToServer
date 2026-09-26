import React, { Component, ErrorInfo } from 'react';
import { Button, Card, Typography, Collapse } from 'antd';
import { ReloadOutlined, BugOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

const { Text, Paragraph } = Typography;
const { Panel } = Collapse;

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: string;
}

/**
 * 管理面板错误边界
 * 捕获所有子组件的运行时错误，并显示友好的错误界面
 */
export default function AdminErrorBoundary({ children }: ErrorBoundaryProps) {
  const { t } = useTranslation();

  // 使用 class component 作为错误边界
  // 因为 hooks 不能在错误边界中直接使用
  class ErrorBoundaryClass extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
      super(props);
      this.state = {
        hasError: false,
        error: null,
        errorInfo: '',
      };
    }

    static getDerivedStateFromError(error: Error) {
      return { hasError: true, error, errorInfo: '' };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
      this.setState({
        error,
        errorInfo: errorInfo.componentStack || '',
      });
    }

    render() {
      if (this.state.hasError && this.state.error) {
        return (
          <ErrorDisplay
            error={this.state.error}
            errorInfo={this.state.errorInfo}
            onRetry={() => this.setState({ hasError: false, error: null, errorInfo: '' })}
            onReload={() => window.location.reload()}
            t={t}
          />
        );
      }

      return this.props.children;
    }
  }

  return <ErrorBoundaryClass>{children}</ErrorBoundaryClass>;
}

interface ErrorDisplayProps {
  error: Error;
  errorInfo: string;
  onRetry: () => void;
  onReload: () => void;
  t: (key: string) => string;
}

function ErrorDisplay({ error, errorInfo, onRetry, onReload, t }: ErrorDisplayProps) {
  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <Card
        type="inner"
        title={
          <span style={{ color: '#ff4d4f' }}>
            <BugOutlined style={{ marginRight: 8 }} />
            {t('admin.adminErrorTitle')}
          </span>
        }
        extra={
          <Button type="primary" icon={<ReloadOutlined />} onClick={onReload}>
            {t('admin.adminErrorRefresh')}
          </Button>
        }
      >
        <Paragraph>
          <Text strong>{t('admin.adminErrorType')}</Text> {error.name || 'Unknown Error'}
        </Paragraph>

        <Paragraph>
          <Text strong>{t('admin.adminErrorMessage')}</Text>
          <Text type="danger">{error.message || t('common.unknownError')}</Text>
        </Paragraph>

        {error.stack && (
          <Collapse style={{ marginTop: 16 }}>
            <Panel header={t('admin.adminErrorStack')} key="stack">
              <Paragraph>
                <pre
                  style={{
                    background: '#1e1e1e',
                    color: '#d4d4d4',
                    padding: 16,
                    borderRadius: 8,
                    overflow: 'auto',
                    fontSize: 12,
                    maxHeight: 400,
                  }}
                >
                  {error.stack}
                </pre>
              </Paragraph>
            </Panel>
          </Collapse>
        )}

        {errorInfo && (
          <Collapse style={{ marginTop: 16 }}>
            <Panel header={t('admin.adminErrorComponentStack')} key="componentStack">
              <Paragraph>
                <pre
                  style={{
                    background: '#1e1e1e',
                    color: '#d4d4d4',
                    padding: 16,
                    borderRadius: 8,
                    overflow: 'auto',
                    fontSize: 12,
                    maxHeight: 400,
                  }}
                >
                  {errorInfo}
                </pre>
              </Paragraph>
            </Panel>
          </Collapse>
        )}

        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <Button type="primary" onClick={onRetry} style={{ marginRight: 12 }}>
            {t('admin.adminErrorRetry')}
          </Button>
          <Button onClick={onReload}>{t('admin.adminErrorRefresh')}</Button>
        </div>

        <Paragraph style={{ marginTop: 16, fontSize: 12, color: '#8c8c8c' }}>
          {t('admin.adminErrorPersists')}
          <ol>
            <li>{t('admin.adminErrorOpenDevTools')}</li>
            <li>{t('admin.adminErrorCheckNetwork')}</li>
            <li>{t('admin.adminErrorCheckPermission')}</li>
            <li>{t('admin.adminErrorContactDev')}</li>
          </ol>
        </Paragraph>
      </Card>
    </div>
  );
}
