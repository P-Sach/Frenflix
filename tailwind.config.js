/**
 * Theme ported from WeFlix_v2 (MIT, Copyright (c) 2026 Phyo Min Thein) —
 * see ATTRIBUTION.md. The palette, the Outfit face and the 2/3 poster ratio
 * are what make the interface read as that interface rather than a generic
 * dark app, so they are copied rather than approximated.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        gray: {
          900: '#121212',
          800: '#1a1a1a',
          700: '#2a2a2a',
          600: '#404040',
          500: '#6b7280',
          400: '#9ca3af',
          300: '#d1d5db',
        },
        // Surfaces the cards and panels sit on.
        ink: '#0a0c12',
        card: '#0d1117',
        shade: '#111827',
        edge: 'rgba(255,255,255,0.10)',
        panel: '#14161c',
        accent: '#dc2626',
      },
      aspectRatio: {
        '16/7': '16 / 7',
        '2/3': '2 / 3',
        '3/2': '3 / 2',
      },
      screens: {
        xs: '475px',
        mobile: { max: '767px' },
      },
      spacing: {
        'safe-bottom': 'env(safe-area-inset-bottom, 1rem)',
      },
    },
  },
  plugins: [],
};
