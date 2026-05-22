/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  corePlugins: { preflight: false }, // don't reset existing styles
  theme: {
    extend: {
      colors: {
        'accent-blue': '#00d4aa',
        'surface': {
          DEFAULT: '#0b0f1a',
          card:    '#0d1117',
          hover:   '#161e2e',
          border:  '#1e293b',
        },
      },
    },
  },
  plugins: [],
}
