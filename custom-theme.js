/**
 * Custom theme script for JSDoc documentation
 * Provides auto/light/dark mode with localStorage persistence
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'hype-docs-theme';
  const THEMES = {
    AUTO: 'auto',
    LIGHT: 'light',
    DARK: 'dark'
  };

  // CSS for dark mode and theme toggle
  const darkModeStyles = `
    :root {
      --bg-primary: #ffffff;
      --bg-secondary: #f8f9fa;
      --bg-code: #f5f5f5;
      --text-primary: #212529;
      --text-secondary: #6c757d;
      --border-color: #dee2e6;
      --link-color: #0d6efd;
      --link-hover: #0a58ca;
      --nav-bg: #ffffff;
      --nav-border: #dee2e6;
      --sidebar-bg: #f8f9fa;
      --code-bg: #f5f5f5;
      --code-border: #e9ecef;
    }

    [data-theme="dark"] {
      --bg-primary: #1a1a1a;
      --bg-secondary: #2d2d2d;
      --bg-code: #2d2d2d;
      --text-primary: #e9ecef;
      --text-secondary: #adb5bd;
      --border-color: #495057;
      --link-color: #6ea8fe;
      --link-hover: #9ec5fe;
      --nav-bg: #212529;
      --nav-border: #495057;
      --sidebar-bg: #2d2d2d;
      --code-bg: #2d2d2d;
      --code-border: #495057;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      transition: background-color 0.3s ease, color 0.3s ease;
    }

    nav, #main {
      background-color: var(--bg-primary);
      color: var(--text-primary);
    }

    .navbar, header {
      background-color: var(--nav-bg);
      border-color: var(--nav-border);
    }

    .sidebar {
      background-color: var(--sidebar-bg);
    }

    pre, code {
      background-color: var(--code-bg);
      border-color: var(--code-border);
      color: var(--text-primary);
    }

    a {
      color: var(--link-color);
    }

    a:hover {
      color: var(--link-hover);
    }

    .card, .panel, article {
      background-color: var(--bg-secondary);
      border-color: var(--border-color);
    }

    h1, h2, h3, h4, h5, h6 {
      color: var(--text-primary);
    }

    .description, .details, dt, dd {
      color: var(--text-primary);
    }

    table {
      color: var(--text-primary);
      border-color: var(--border-color);
    }

    table th {
      background-color: var(--bg-secondary);
      border-color: var(--border-color);
    }

    table td {
      border-color: var(--border-color);
    }

    /* Theme toggle button */
    .theme-toggle {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 1000;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      transition: all 0.3s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }

    [data-theme="dark"] .theme-toggle {
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }

    .theme-toggle:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    .theme-toggle-icon {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .theme-toggle-label {
      font-weight: 500;
      color: var(--text-primary);
    }

    /* Icon styles */
    .icon-sun, .icon-moon, .icon-auto {
      display: none;
    }

    [data-theme="light"] .icon-sun,
    [data-theme="dark"] .icon-moon,
    [data-theme="auto"] .icon-auto {
      display: block;
    }

    /* Smooth transitions */
    * {
      transition-property: background-color, border-color, color;
      transition-duration: 0.3s;
      transition-timing-function: ease;
    }

    /* Syntax highlighting adjustments for dark mode */
    [data-theme="dark"] .hljs {
      background: var(--code-bg);
      color: #e9ecef;
    }

    [data-theme="dark"] .hljs-keyword {
      color: #ff79c6;
    }

    [data-theme="dark"] .hljs-string {
      color: #50fa7b;
    }

    [data-theme="dark"] .hljs-number {
      color: #bd93f9;
    }

    [data-theme="dark"] .hljs-comment {
      color: #6272a4;
    }

    [data-theme="dark"] .hljs-function {
      color: #8be9fd;
    }

    /* Responsive adjustments */
    @media (max-width: 768px) {
      .theme-toggle {
        top: 10px;
        right: 10px;
        padding: 6px 10px;
        font-size: 12px;
      }

      .theme-toggle-icon {
        width: 16px;
        height: 16px;
      }
    }
  `;

  /**
   * Get system preference for dark mode
   */
  function getSystemTheme() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  /**
   * Get saved theme preference or default to auto
   */
  function getSavedTheme() {
    return localStorage.getItem(STORAGE_KEY) || THEMES.AUTO;
  }

  /**
   * Save theme preference
   */
  function saveTheme(theme) {
    localStorage.setItem(STORAGE_KEY, theme);
  }

  /**
   * Apply theme to document
   */
  function applyTheme(theme) {
    let effectiveTheme = theme;

    if (theme === THEMES.AUTO) {
      effectiveTheme = getSystemTheme();
    }

    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }

  /**
   * Cycle through themes: light -> dark -> auto -> light
   */
  function cycleTheme() {
    const currentTheme = getSavedTheme();
    let nextTheme;

    switch (currentTheme) {
      case THEMES.LIGHT:
        nextTheme = THEMES.DARK;
        break;
      case THEMES.DARK:
        nextTheme = THEMES.AUTO;
        break;
      case THEMES.AUTO:
      default:
        nextTheme = THEMES.LIGHT;
        break;
    }

    saveTheme(nextTheme);
    applyTheme(nextTheme);
    updateToggleButton(nextTheme);
  }

  /**
   * Update theme toggle button appearance
   */
  function updateToggleButton(theme) {
    const button = document.querySelector('.theme-toggle');
    if (!button) return;

    const label = button.querySelector('.theme-toggle-label');
    if (!label) return;

    const labels = {
      [THEMES.LIGHT]: 'Light',
      [THEMES.DARK]: 'Dark',
      [THEMES.AUTO]: 'Auto'
    };

    label.textContent = labels[theme];
    document.documentElement.setAttribute('data-theme-mode', theme);
  }

  /**
   * Create theme toggle button
   */
  function createToggleButton() {
    const button = document.createElement('button');
    button.className = 'theme-toggle';
    button.setAttribute('aria-label', 'Toggle theme');
    button.innerHTML = `
      <div class="theme-toggle-icon">
        <svg class="icon-sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="5"/>
          <line x1="12" y1="1" x2="12" y2="3"/>
          <line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/>
          <line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
        <svg class="icon-moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
        <svg class="icon-auto" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/>
          <line x1="9" y1="21" x2="9" y2="9"/>
        </svg>
      </div>
      <span class="theme-toggle-label">Light</span>
    `;

    button.addEventListener('click', cycleTheme);
    document.body.appendChild(button);
  }

  /**
   * Initialize theme system
   */
  function init() {
    // Inject styles
    const styleElement = document.createElement('style');
    styleElement.textContent = darkModeStyles;
    document.head.appendChild(styleElement);

    // Apply saved theme immediately to prevent flash
    const savedTheme = getSavedTheme();
    applyTheme(savedTheme);

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        createToggleButton();
        updateToggleButton(savedTheme);
      });
    } else {
      createToggleButton();
      updateToggleButton(savedTheme);
    }

    // Listen for system theme changes when in auto mode
    if (window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      mediaQuery.addEventListener('change', function() {
        const currentTheme = getSavedTheme();
        if (currentTheme === THEMES.AUTO) {
          applyTheme(THEMES.AUTO);
        }
      });
    }
  }

  // Initialize immediately
  init();

  // Expose theme API globally for debugging
  window.HypeDocsTheme = {
    getTheme: getSavedTheme,
    setTheme: function(theme) {
      if (Object.values(THEMES).includes(theme)) {
        saveTheme(theme);
        applyTheme(theme);
        updateToggleButton(theme);
      }
    },
    cycleTheme: cycleTheme
  };
})();
