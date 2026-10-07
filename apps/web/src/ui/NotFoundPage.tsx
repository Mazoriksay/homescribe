import { Link } from 'react-router';
import { useT } from '../i18n/useT';

export function NotFoundPage() {
  const t = useT();
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <h1>{t('notFound.title')}</h1>
      <Link to="/">{t('recording.back')}</Link>
    </div>
  );
}
