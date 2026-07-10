import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import PortalStackScreen from '../components/PortalStackScreen';
import { useAuthStore } from '../store/authStore';

export default function OrgChartScreen() {
  const { t } = useTranslation();
  const { deviceId, deviceSecret } = useAuthStore();

  const url = useMemo(() => {
    const base = 'https://eclawbot.com/portal/dashboard.html?embed=1&view=orgchart';
    if (deviceId && deviceSecret) {
      return `${base}&deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`;
    }
    return base;
  }, [deviceId, deviceSecret]);

  return <PortalStackScreen title={t('home.org_chart')} url={url} />;
}
