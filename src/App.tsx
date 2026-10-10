import { useCallback, useState } from 'react';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './components/Toast';
import { CleanupPage } from './pages/CleanupPage';
import { HomePage } from './pages/HomePage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import type { PageKey } from './types';

export default function App() {
  const [page, setPage] = useState<PageKey>('home');

  const gotoCleanup = useCallback(() => setPage('cleanup'), []);
  const gotoHome = useCallback(() => setPage('home'), []);

  return (
    <ToastProvider>
      <AppShell current={page} onNavigate={setPage} version={`v${__APP_VERSION__}`}>
        {page === 'home' && <HomePage onNavigateToCleanup={gotoCleanup} />}
        {page === 'cleanup' && <CleanupPage onRescanRequest={gotoHome} />}
        {page === 'profile' && <ProfilePage />}
        {page === 'settings' && <SettingsPage />}
      </AppShell>
    </ToastProvider>
  );
}
