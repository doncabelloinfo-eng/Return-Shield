import type { Config } from 'tailwindcss';

/**
 * The prototype drives everything through CSS variables and swaps the whole set
 * for dark mode. We keep that: the variables live in app/globals.css, Tailwind
 * only names them. Adding a colour means adding it in both places, on purpose —
 * a colour that has no dark value is a colour that breaks at night.
 */
const v = (name: string) => `var(--${name})`;

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: v('ground'),
        surface: v('surface'),
        surface2: v('surface2'),
        navy: v('navy'),
        navy2: v('navy2'),
        accent: v('accent'),
        ink: v('ink'),
        muted: v('muted'),
        line: v('line'),
        good: v('good'),
        warn: v('warn'),
        crit: v('crit'),
        critsoft: v('critsoft'),
        warnsoft: v('warnsoft'),
        goodsoft: v('goodsoft'),
        retbg: v('retbg'),
        hover: v('hover'),
        navmuted: v('navmuted'),
      },
      fontFamily: {
        display: ['Archivo', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        focus: '0 10px 30px rgba(16,32,61,.10)',
        menu: '0 14px 34px rgba(16,32,61,.18)',
        toast: '0 14px 34px rgba(11,18,32,.4)',
        card: '0 10px 26px rgba(16,32,61,.14)',
      },
    },
  },
  plugins: [],
};
export default config;
