/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./pages/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        dark: { 900: '#0a0e17', 800: '#0f1623', 700: '#151e2d', 600: '#1c2a3f', 500: '#243552' },
        accent: { green: '#00d4a0', red: '#ff4757', blue: '#3d8ef8', yellow: '#ffd32a', purple: '#9c88ff' },
      },
      fontFamily: { mono: ['JetBrains Mono', 'Fira Code', 'monospace'] },
    },
  },
  plugins: [],
};
