// PostCSS configuration for the dev server.
// - Enables Tailwind CSS and Autoprefixer for the playground build pipeline.
// - Run `pnpm run build:css` (or `pnpm run watch:css`) in `playground/dev-server` to produce /tailwind.css.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
