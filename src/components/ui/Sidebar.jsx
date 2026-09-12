import { NavLink } from 'react-router-dom';
import {
  BiCameraMovie, BiListPlus, BiPlayCircle, BiSearch, BiCloudDownload, BiLinkAlt,
} from 'react-icons/bi';
import { FaPlay } from 'react-icons/fa';

/**
 * The collapsible icon rail.
 *
 * Ported from WeFlix_v2's Sidebar (MIT, Copyright (c) 2026 Phyo Min Thein) —
 * see ATTRIBUTION.md: 84px collapsed, 260px on hover, labels fading in behind
 * the width transition, a red gradient brand mark, and active items marked
 * with a red-tinted border rather than a filled block.
 *
 * Their rail navigates TMDB genres. A library of files has no genres, so the
 * items are the questions you actually ask of your own files: what am I part
 * way through, what is queued, what came from Drive, what still needs pairing.
 */
const item = ({ isActive }) => [
  'relative flex items-center gap-4 rounded-xl border px-[26px] py-3 transition-colors duration-200',
  isActive
    ? 'border-red-500/35 bg-red-500/15 text-white'
    : 'border-transparent text-gray-400 hover:bg-white/[0.06] hover:text-white',
].join(' ');

const label = 'whitespace-nowrap text-sm font-semibold opacity-0 transition-opacity duration-200 delay-75 group-hover:opacity-100';

export default function Sidebar({ counts = {}, onOpenDrive }) {
  return (
    <aside
      className="group fixed left-0 top-0 z-50 hidden h-full w-[84px] select-none flex-col overflow-hidden border-r border-white/10 bg-gray-900/95 shadow-2xl shadow-black/30 backdrop-blur-xl transition-[width] duration-300 ease-in-out hover:w-[260px] md:flex"
    >
      <NavLink to="/" className="flex items-center gap-4 px-[26px] py-6">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-red-500 to-red-700 shadow-lg shadow-red-900/40">
          <FaPlay className="ml-0.5 text-[11px] text-white" />
        </span>
        <span className={`${label} text-lg font-black tracking-tight text-white`}>
          Fren<span className="text-accent">Flix</span>
        </span>
      </NavLink>

      <nav className="flex flex-1 flex-col gap-1 px-3 pt-2">
        <NavLink to="/" end className={item}>
          <BiCameraMovie className="shrink-0 text-2xl" />
          <span className={label}>Library</span>
          <Count n={counts.all} />
        </NavLink>
        <NavLink to="/continue" className={item}>
          <BiPlayCircle className="shrink-0 text-2xl" />
          <span className={label}>Continue</span>
          <Count n={counts.continues} />
        </NavLink>
        <NavLink to="/queue" className={item}>
          <BiListPlus className="shrink-0 text-2xl" />
          <span className={label}>Queue</span>
          <Count n={counts.queue} />
        </NavLink>
        <NavLink to="/drive" className={item}>
          <BiCloudDownload className="shrink-0 text-2xl" />
          <span className={label}>From Drive</span>
          <Count n={counts.drive} />
        </NavLink>
        <NavLink to="/unpaired" className={item}>
          <BiLinkAlt className="shrink-0 text-2xl" />
          <span className={label}>Unpaired</span>
          <Count n={counts.unpaired} />
        </NavLink>
        <NavLink to="/search" className={item}>
          <BiSearch className="shrink-0 text-2xl" />
          <span className={label}>Search</span>
        </NavLink>
      </nav>

      <div className="px-3 pb-6">
        <button
          type="button"
          onClick={onOpenDrive}
          className="flex w-full items-center gap-4 rounded-xl border border-transparent px-[26px] py-3 text-gray-400 transition-colors duration-200 hover:bg-white/[0.06] hover:text-white"
        >
          <BiCloudDownload className="shrink-0 text-2xl" />
          <span className={label}>Add from Drive</span>
        </button>
      </div>
    </aside>
  );
}

/** Counts only make sense once the labels are showing. */
function Count({ n }) {
  if (!n) return null;
  return (
    <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-gray-300 opacity-0 transition-opacity duration-200 delay-75 group-hover:opacity-100">
      {n}
    </span>
  );
}
