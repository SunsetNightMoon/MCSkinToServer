/**
 * 起始页（plan3 Landing 设计：星空 + 右对齐 Hero + CTA）
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RightOutlined } from '@ant-design/icons';
import { useAuthStore } from '../store/auth';
import { useSiteStore } from '../store/site';
import { TopNav } from '../components/TopNav';
import './Landing.css';

export function LandingPage() {
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
          { path: '/', label: '首页' },
          { path: '/library', label: '公开库' },
          { path: '/wardrobe', label: '我的衣柜', auth: true },
          { path: '/profiles', label: '我的角色', auth: true },
        ]}
      />

      <section className="landing-hero">
        <div className="landing-hero__content">
          <h1 className="landing-hero__title">
            欢迎来到
            <br />
            <span className="landing-hero__title-accent">MSCTS</span>
          </h1>
          <p className="landing-hero__subtitle">MINECRAFT SKIN &amp; CAPE SERVER</p>
          <div className="landing-hero__cta">
            <button
              className="landing-hero__btn landing-hero__btn--secondary"
              onClick={() => navigate('/library')}
            >
              浏览公开库
            </button>
            <button
              className="landing-hero__btn landing-hero__btn--primary"
              onClick={() => navigate(isAuthenticated ? '/wardrobe' : '/login')}
            >
              {isAuthenticated ? '进入我的衣柜' : '登录 / 注册'} <RightOutlined />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
