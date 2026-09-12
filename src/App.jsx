import { Route, Routes } from 'react-router-dom';
import AppShell from './components/ui/AppShell';
import { LibraryProvider } from './context/LibraryContext';
import FilterPage from './pages/FilterPage';
import LibraryPage from './pages/LibraryPage';
import SearchPage from './pages/SearchPage';
import WatchPage from './pages/WatchPage';

export default function App() {
  return (
    <LibraryProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/watch/:id" element={<WatchPage />} />
          <Route path="/:view" element={<FilterPage />} />
          <Route path="*" element={<LibraryPage />} />
        </Route>
      </Routes>
    </LibraryProvider>
  );
}
