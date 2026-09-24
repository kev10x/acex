/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      // Softer, layered, faintly indigo-tinted shadows: gives cards depth
      // without the hard grey edge of Tailwind's defaults.
      boxShadow: {
        DEFAULT: '0 1px 2px rgba(20, 24, 41, 0.06), 0 1px 3px rgba(20, 24, 41, 0.05)',
        sm: '0 1px 2px rgba(20, 24, 41, 0.05)',
        md: '0 4px 12px -2px rgba(20, 24, 41, 0.08), 0 2px 4px -2px rgba(20, 24, 41, 0.05)',
        lg: '0 12px 28px -6px rgba(20, 24, 41, 0.12), 0 4px 10px -4px rgba(20, 24, 41, 0.06)',
        xl: '0 24px 48px -12px rgba(49, 46, 129, 0.18), 0 8px 16px -8px rgba(20, 24, 41, 0.08)',
        glow: '0 8px 24px -6px rgba(79, 70, 229, 0.45)',
      },
      borderRadius: {
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
      },
      colors: {
        // Cool, faintly indigo-tinted neutrals replacing Tailwind's flat grey,
        // so every existing gray-* class picks up the brand without edits.
        gray: {
          50: '#f8f9fc',
          100: '#f1f3f9',
          200: '#e4e8f1',
          300: '#cdd3e2',
          400: '#9aa3bb',
          500: '#6b7591',
          600: '#4f5873',
          700: '#3b435c',
          800: '#262c42',
          900: '#141829',
        },
        // Acexen brand palette: indigo/violet, matching the marketing site
        // (acexen.com root hero panel) instead of MarkMate's original blue.
        primary: {
          DEFAULT: '#4f46e5',
          foreground: '#ffffff',
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
        accent: {
          DEFAULT: '#7c3aed',
          foreground: '#ffffff',
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
        },
      }
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
  ],
}

