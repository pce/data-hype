// Tailwind config for the dev playground
// - Scans local example HTML and built JS for used classes.
// - Kept minimal and compatible with Tailwind v3 LTS used in the dev image.
//
// Note:
//  - Ensure you run `pnpm run build:css` (or `watch:css`) in `playground/dev-server`
//    so `/tailwind.css` is produced and served by the dev backend.
//  - The `content` globs purposely include `public/**/*.html` and built JS under
//    `public/static/js` so example markup and runtime-generated classes are picked up.

module.exports = {
  content: [
    // Example pages and templates
    './public/**/*.html',

    // Any JS that may contain Tailwind class names (built/runtime helpers)
    './public/static/js/**/*.js',
    './public/static/**/*.js',

    // Source trees that might contain example/demo code referencing classes
    '../src/**/*.ts',
    '../../src/**/*.ts'
  ],
  theme: {
    extend: {
      // Add any project-specific theme customizations here.
      // e.g. colors, spacing, etc.
    },
  },
  plugins: [
    // Add Tailwind plugins if/when needed, e.g. require('@tailwindcss/forms')
  ],
};
