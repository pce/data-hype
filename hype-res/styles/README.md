# Design System CSS Modules

## Files

- `base.css` - CSS variables, reset, typography
- `layout.css` - Layout, sidebar, main, sections, footer
- `components.css` - Buttons, cards, grids, feed items
- `loading-states.css` - Loading overlays, spinners, skeletons, animations

## Usage

```html
<link rel="stylesheet" href="./styles/index.css">
```

## Theme Support

- Light theme (default)
- Dark theme (auto-detect via `prefers-color-scheme`)

## Components

### Buttons
```html
<button class="btn">Click me</button>
<button class="btn btn-danger">Delete</button>
<button class="btn" data-loading-text="Loading...">Loading</button>
```

### Cards
```html
<div class="card">Card content</div>
<div class="card-loading">Loading card...</div>
```

### Feed Items
```html
<div class="feed-item">Item content</div>
<div class="feed-item-loading">Loading item...</div>
```

### Loading States
```html
<div class="skeleton-text" style="height: 20px; width: 50%;"></div>
<div class="skeleton-image" style="height: 100px; width: 200px;"></div>
```
