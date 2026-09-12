import { NavLink } from 'react-router-dom';
import { BiCameraMovie, BiListPlus, BiPlayCircle, BiSearch } from 'react-icons/bi';

/**
 * The rail is `hidden md:flex` in the original, which leaves phones with no
 * navigation at all. This is the missing half — a bottom bar on small screens,
 * sitting above the home indicator via the safe-area inset the theme defines.
 */
const item = ({ isActive }) => [
  'flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-semibold transition-colors',
  isActive ? 'text-red-400' : 'text-gray-500',
].join(' ');

export default function MobileNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 flex border-t border-white/10 bg-gray-900/95 pb-safe-bottom backdrop-blur-xl md:hidden">
      <NavLink to="/" end className={item}><BiCameraMovie className="text-xl" />Library</NavLink>
      <NavLink to="/continue" className={item}><BiPlayCircle className="text-xl" />Continue</NavLink>
      <NavLink to="/queue" className={item}><BiListPlus className="text-xl" />Queue</NavLink>
      <NavLink to="/search" className={item}><BiSearch className="text-xl" />Search</NavLink>
    </nav>
  );
}
