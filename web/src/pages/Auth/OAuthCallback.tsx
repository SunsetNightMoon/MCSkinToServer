import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Spin, Result, Button } from 'antd'
import { useAuthStore } from '../../store/authStore'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useTranslation } from 'react-i18next'
import axios from 'axios'

export function OAuthCallback() {
  const { t } = useTranslation()
  usePageTitle(t('auth.oauthLogin', 'OAuth Login'))
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const setAuth = useAuthStore((state) => state.setAuth)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const token = searchParams.get('token')
    const isNewUser = searchParams.get('new_user') === 'true'

    if (!token) {
      setError(t('auth.missingToken', 'Missing authentication token, please login again'))
      return
    }

    const fetchUser = async () => {
      try {
        const response = await axios.get('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })

        const data = response.data
        const profileName = data.profileName || null
        const profileId = data.profiles?.[0]?.id || null
        setAuth(token, data.user, data.skinUrl, profileName, profileId)

        if (isNewUser) {
          navigate('/profile', { state: { oauthNewUser: true }, replace: true })
        } else {
          navigate('/', { replace: true })
        }
      } catch (err: any) {
        setError(err.response?.data?.errorMessage || t('auth.fetchUserFailed', 'Failed to fetch user info, please login again'))
      }
    }

    fetchUser()
  }, [searchParams, setAuth, navigate, t])

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Result
          status="error"
          title={t('auth.oauthLoginFailed', 'OAuth Login Failed')}
          subTitle={error}
          extra={
            <Button type="primary" href="/login">
              {t('auth.backToLogin', 'Back to Login')}
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <Spin size="large" tip={t('auth.completingOAuth', 'Completing OAuth login...')} />
    </div>
  )
}
