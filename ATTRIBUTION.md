# Attribution

The interface is ported from **[WeFlix_v2](https://github.com/kweephyo-pmt/WeFlix_v2)** by
Phyo Min Thein, used under the MIT licence. The layout, palette, typography, card and row
structure, hero carousel and sidebar behaviour follow that project; the data behind them does
not — WeFlix_v2 is a TMDB discovery app, this is a player for files you already have.

Files adapted from it:

| Here | There |
|---|---|
| `src/components/ui/ContentCard.jsx` | `src/pages/Home/ContentCard.jsx` |
| `src/components/ui/ContentRow.jsx` | `src/pages/Home/TrendingRow.jsx` |
| `src/components/ui/ContentGrid.jsx` | `src/pages/Home/ContentGrid.jsx` |
| `src/components/ui/HeroBanner.jsx` | `src/pages/Home/HeroBanner.jsx` |
| `src/components/ui/Sidebar.jsx` | `src/pages/Home/Sidebar.jsx` |
| `src/components/ui/AppShell.jsx` | `src/pages/Home/ParentComponent.jsx` |
| `src/pages/SearchPage.jsx` | `src/pages/Home/SearchPage.jsx` |
| `src/pages/WatchPage.jsx` (layout) | `src/pages/Home/Movie/MovieDetails.jsx` |
| `tailwind.config.js`, `src/index.css` | same paths |

Nothing was taken from its Firebase, TMDB or embedded-player code: there is no account system
here, no external metadata, and the player is FrenFlix's own.

---

MIT License

Copyright (c) 2026 Phyo Min Thein

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
