/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'system-ui', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
      },
      colors: {
        primary: { DEFAULT: '#0075de', active: '#005bab' },
      },
      boxShadow: {
        // Notion's "barely-there" elevation: many near-transparent layers, no hard cast.
        notion: '0 0.175px 1.041px rgba(0,0,0,.01), 0 0.8px 2.925px rgba(0,0,0,.02), 0 2.025px 7.847px rgba(0,0,0,.027), 0 4px 18px rgba(0,0,0,.04)',
      },
    },
  },
  plugins: [],
};
