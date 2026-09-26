/**
 * 起始页（plan3 Landing 设计：星空 + 右对齐 Hero + CTA）
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RightOutlined, LinkOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/auth';
import { useSiteStore } from '../store/site';
import { usePageTitle } from '../hooks/usePageTitle';
import { TopNav } from '../components/TopNav';
import './Landing.css';

export function LandingPage() {
  const { t } = useTranslation();
  usePageTitle(null);
  const isAuthenticated = useAuthStore((s) => s.token !== null);
  const { theme } = useSiteStore();
  const navigate = useNavigate();

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="landing-page" data-theme={theme}>
      {theme === 'dark' ? (
        <div className="starfield-bg">
          <div className="starfield-bg__stars" />
          <div className="starfield-bg__shooting-star" />
          <div className="starfield-bg__fog" />
        </div>
      ) : (
        <div className="light-bg" />
      )}

      <TopNav
        brandOnClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        links={[
          { path: '/', label: 'nav.home' },
          { path: '/library', label: 'nav.library' },
          { path: '/upload', label: 'nav.upload', auth: true },
          { path: '/wardrobe', label: 'nav.wardrobe', auth: true },
          { path: '/profile', label: 'nav.profile', auth: true },
          { path: '/admin', label: 'nav.admin', auth: true, admin: true },
        ]}
      />

      <section className="landing-hero">
        <div className="landing-hero__content">
          <h1 className="landing-hero__title">
            {t('landing.welcomePrefix')}
            <br />
            <span className="landing-hero__title-accent">MSCTS</span>
          </h1>
          <p className="landing-hero__subtitle">{t('landing.subtitle')}</p>
          <div className="landing-hero__cta">
            <button
              className="landing-hero__btn landing-hero__btn--secondary"
              onClick={() => navigate('/library')}
            >
              {t('landing.browseLibrary')} <LinkOutlined style={{ fontSize: 12, marginLeft: 4 }} />
            </button>
            <button
              className="landing-hero__btn landing-hero__btn--primary"
              onClick={() => navigate(isAuthenticated ? '/wardrobe' : '/login')}
            >
              {isAuthenticated ? t('landing.enterWardrobe') : t('landing.loginOrRegister')}{' '}
              <RightOutlined />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
