import { useTranslation } from 'react-i18next';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import {
  App as AntApp,
  ConfigProvider,
  Layout,
  Menu,
  Space,
  theme,
} from 'antd';
import itIT from 'antd/locale/it_IT';
import enUS from 'antd/locale/en_US';
import { CloudServerOutlined } from '@ant-design/icons';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { UploadPage } from './pages/UploadPage';
import { BatchPage } from './pages/BatchPage';
import { HistoryPage } from './pages/HistoryPage';

const { Header, Content, Footer } = Layout;

export function App() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const isEnglish = i18n.language.startsWith('en');

  const selectedKey = location.pathname.startsWith('/history')
    ? 'history'
    : 'new';

  return (
    <ConfigProvider
      locale={isEnglish ? enUS : itIT}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: { colorPrimary: '#0b5fae' },
      }}
    >
      <AntApp>
        <Layout style={{ minHeight: '100vh' }}>
          <Header className="app-header">
            <span className="app-header__title">
              <CloudServerOutlined />
              {t('app.title')}
            </span>
            <Menu
              className="app-header__menu"
              theme="dark"
              mode="horizontal"
              selectedKeys={[selectedKey]}
              items={[
                {
                  key: 'new',
                  label: <Link to="/">{t('nav.newCheck')}</Link>,
                },
                {
                  key: 'history',
                  label: <Link to="/history">{t('nav.history')}</Link>,
                },
                {
                  key: 'docs',
                  label: (
                    <a href="/api/docs" target="_blank" rel="noreferrer">
                      {t('nav.apiDocs')}
                    </a>
                  ),
                },
              ]}
            />
            <Space>
              <LanguageSwitcher />
            </Space>
          </Header>

          <Content>
            <div className="app-content">
              <Routes>
                <Route path="/" element={<UploadPage />} />
                <Route path="/batches/:id" element={<BatchPage />} />
                <Route path="/history" element={<HistoryPage />} />
              </Routes>
            </div>
          </Content>

          <Footer className="app-footer">
            {t('app.title')} · {t('app.subtitle')}
          </Footer>
        </Layout>
      </AntApp>
    </ConfigProvider>
  );
}
