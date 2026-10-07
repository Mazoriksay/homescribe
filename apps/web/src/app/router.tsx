import { createBrowserRouter } from 'react-router';
import { LibraryPage } from '../features/library/LibraryPage';
import { RecordingPage } from '../features/recording/RecordingPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { Layout } from '../ui/Layout';
import { NotFoundPage } from '../ui/NotFoundPage';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <LibraryPage /> },
      { path: '/recordings/:id', element: <RecordingPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
