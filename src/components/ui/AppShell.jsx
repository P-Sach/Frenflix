import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import DriveBrowser from '../DriveBrowser';
import MobileNav from './MobileNav';
import Sidebar from './Sidebar';
import { useLibrary } from '../../context/LibraryContext';
import { useWatchProgress } from '../../lib/useWatchProgress';

/**
 * Layout route: rail on the left, page in the outlet, scroll reset between
 * pages. Ported from WeFlix_v2's ParentComponent
 * (MIT, Copyright (c) 2026 Phyo Min Thein) — see ATTRIBUTION.md.
 */
export default function AppShell() {
  const { entries, looseAudios, looseSubtitles, queue, addDriveFiles } = useLibrary();
  const { forEntry } = useWatchProgress();
  const [driveOpen, setDriveOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  const counts = {
    all: entries.length,
    continues: entries.filter((e) => forEntry(e)?.canResume).length,
    queue: queue.length,
    drive: entries.filter((e) => e.fromDrive).length,
    unpaired: looseAudios.length + looseSubtitles.length,
  };

  return (
    <div className="min-h-screen bg-ink text-gray-300">
      <Sidebar counts={counts} onOpenDrive={() => setDriveOpen(true)} />
      <main className="pb-24 md:pb-0 md:pl-[84px]">
        <Outlet context={{ openDrive: () => setDriveOpen(true) }} />
      </main>
      <MobileNav />
      <DriveBrowser open={driveOpen} onClose={() => setDriveOpen(false)} onAdd={addDriveFiles} />
    </div>
  );
}
