# Hype Reactive State System

## Overview

Hype's reactive system provides Alpine.js-inspired declarative state management directly in your HTML markup. It seamlessly integrates with Hype's existing HTTP request system, allowing you to build interactive UIs without writing JavaScript.

## Philosophy

- **Markup-driven**: Declare state and behavior directly in HTML attributes
- **Progressive enhancement**: Works alongside Hype's existing features
- **No build step**: Pure HTML attributes, no compilation needed
- **Server-friendly**: Easily sync state changes with backend endpoints

## Core Directives

### `data-hype-state`

Declares reactive state for a component. All child elements can access this state.

**Syntax:**
```html
<div data-hype-state='{ "key": value, ... }'>
  <!-- children can access state -->
</div>
```

**Examples:**
```html
<!-- Boolean state -->
<div data-hype-state='{ "open": false }'>

<!-- Multiple values -->
<div data-hype-state='{ "count": 0, "loading": false, "user": null }'>

<!-- Nested objects -->
<div data-hype-state='{ "form": { "email": "", "valid": false } }'>
```

**Notes:**
- State must be valid JSON or JavaScript object notation
- State is scoped to the element and its children
- Child elements with their own state create new scopes

---

### `data-hype-on-{event}`

Attaches event handlers with access to state and helper functions.

**Syntax:**
```html
<button data-hype-on-click="expression">
<input data-hype-on-input="expression">
<form data-hype-on-submit="expression">
```

**Available helpers:**
- `toggle(key)` - Toggle a boolean state value
- `set(key, value)` - Set a state value
- `$fetch()` - Trigger Hype HTTP request on the element
- `$state` - Access the full state object
- `$el` - Reference to the current element
- `$event` - The native DOM event object

**Examples:**
```html
<!-- Toggle boolean -->
<button data-hype-on-click="toggle('open')">Toggle</button>

<!-- Set value -->
<button data-hype-on-click="set('count', 0)">Reset</button>

<!-- Increment -->
<button data-hype-on-click="set('count', count + 1)">+1</button>

<!-- Multiple actions -->
<button data-hype-on-click="toggle('loading'); $fetch()">
  Submit
</button>

<!-- Access event -->
<input data-hype-on-input="set('value', $event.target.value)">
```

---

### `data-hype-show`

Conditionally shows/hides elements based on expression evaluation.

**Syntax:**
```html
<div data-hype-show="expression">
  <!-- shown when expression is truthy -->
</div>
```

**Examples:**
```html
<!-- Simple boolean -->
<div data-hype-show="isVisible">Content</div>

<!-- Negation -->
<div data-hype-show="!isHidden">Content</div>

<!-- Comparison -->
<div data-hype-show="count > 0">Count is positive</div>
<div data-hype-show="count === 0">Count is zero</div>

<!-- Complex expression -->
<div data-hype-show="user !== null && user.isAdmin">
  Admin panel
</div>
```

**Behavior:**
- Sets `display: none` and adds `hidden` attribute when false
- Restores original display value when true
- Includes CSS transition support

---

### `data-hype-class-{className}`

Conditionally applies CSS classes based on expression evaluation.

**Syntax:**
```html
<div data-hype-class-className="expression">
```

**Examples:**
```html
<!-- Single class -->
<button data-hype-class-active="isActive">

<!-- Multiple classes on same element -->
<div 
  data-hype-class-bg-blue-500="theme === 'blue'"
  data-hype-class-bg-red-500="theme === 'red'"
  data-hype-class-text-white="theme !== 'default'"
>

<!-- Conditional styling -->
<div data-hype-class-opacity-50="loading">

<!-- State-based variants -->
<button 
  data-hype-class-border-blue-500="activeTab === 'home'"
  data-hype-class-text-blue-600="activeTab === 'home'"
>
```

**Notes:**
- Class name can contain hyphens, colons (for Tailwind variants)
- Expression is evaluated as boolean
- Classes are toggled, not replaced

---

### `data-hype-bind-{attribute}`

Binds HTML attributes to state values.

**Syntax:**
```html
<input data-hype-bind-disabled="loading">
<img data-hype-bind-src="imageUrl">
<a data-hype-bind-href="linkUrl">
```

**Examples:**
```html
<!-- Boolean attributes -->
<button data-hype-bind-disabled="loading">Submit</button>
<input data-hype-bind-required="isRequired">

<!-- Value attributes -->
<input data-hype-bind-value="inputValue">
<img data-hype-bind-src="'/images/' + imageName">

<!-- Data attributes -->
<div data-hype-bind-data-count="count">

<!-- ARIA attributes -->
<button data-hype-bind-aria-expanded="isOpen">
```

**Behavior:**
- `false`, `null`, `undefined`: removes attribute
- `true`: sets attribute with empty value
- Other values: converts to string and sets

---

## Practical Examples

### 1. Favorite/Heart Button

```html
<button 
  data-hype-state='{ "favorited": false }'
  data-hype-post="/api/favorite"
  data-hype-swap="none"
  data-hype-on-click="toggle('favorited'); $fetch()"
  class="btn"
>
  <!-- Outline heart -->
  <svg data-hype-show="!favorited" class="icon">
    <path d="..."/>
  </svg>
  
  <!-- Filled heart -->
  <svg data-hype-show="favorited" class="icon text-red-500">
    <path d="..."/>
  </svg>
</button>
```

### 2. Toggle Panel

```html
<div data-hype-state='{ "expanded": false }'>
  <button data-hype-on-click="toggle('expanded')">
    <span data-hype-show="!expanded">Show More</span>
    <span data-hype-show="expanded">Show Less</span>
  </button>
  
  <div data-hype-show="expanded" class="panel">
    <!-- Content here -->
  </div>
</div>
```

### 3. Tab Component

```html
<div data-hype-state='{ "activeTab": "home" }'>
  <!-- Tab buttons -->
  <button 
    data-hype-on-click="set('activeTab', 'home')"
    data-hype-class-active="activeTab === 'home'"
  >
    Home
  </button>
  <button 
    data-hype-on-click="set('activeTab', 'profile')"
    data-hype-class-active="activeTab === 'profile'"
  >
    Profile
  </button>
  
  <!-- Tab content -->
  <div data-hype-show="activeTab === 'home'">
    Home content
  </div>
  <div data-hype-show="activeTab === 'profile'">
    Profile content
  </div>
</div>
```

### 4. Counter with Server Sync

```html
<div 
  data-hype-state='{ "count": 0 }'
  data-hype-post="/api/counter"
  data-hype-vals='{ "count": count }'
>
  <button data-hype-on-click="set('count', count - 1); $fetch()">
    -
  </button>
  
  <span data-hype-bind-data-value="count">0</span>
  
  <button data-hype-on-click="set('count', count + 1); $fetch()">
    +
  </button>
</div>
```

### 5. Modal Dialog

```html
<div data-hype-state='{ "showModal": false }'>
  <button data-hype-on-click="set('showModal', true)">
    Open Modal
  </button>
  
  <!-- Overlay -->
  <div 
    data-hype-show="showModal"
    data-hype-on-click="set('showModal', false)"
    class="modal-overlay"
  >
    <div data-hype-on-click.stop="" class="modal-content">
      <h2>Modal Title</h2>
      <button data-hype-on-click="set('showModal', false)">
        Close
      </button>
    </div>
  </div>
</div>
```

### 6. Form with Loading State

```html
<form 
  data-hype-state='{ "loading": false }'
  data-hype-post="/api/submit"
  data-hype-on-submit="set('loading', true)"
>
  <input name="email" type="email">
  
  <button 
    data-hype-bind-disabled="loading"
    data-hype-class-opacity-50="loading"
  >
    <span data-hype-show="!loading">Submit</span>
    <span data-hype-show="loading">Submitting...</span>
  </button>
</form>
```

---

## Integration with Hype Requests

The reactive system works seamlessly with Hype's HTTP features:

### Optimistic Updates

```html
<button 
  data-hype-state='{ "liked": false }'
  data-hype-post="/api/like"
  data-hype-on-click="toggle('liked'); $fetch()"
  data-hype-class-text-red-500="liked"
>
  Like
</button>
```

### Server Response Updates

You can update state from server responses using Hype events:

```html
<div 
  data-hype-state='{ "count": 0 }'
  data-hype-get="/api/count"
>
  <button data-hype-on-click="$fetch()">Refresh</button>
  <span data-hype-bind-data-count="count"></span>
</div>

<script>
document.addEventListener('hype:after-swap', (e) => {
  const el = e.detail.target;
  const state = hype.reactive.getState(el);
  if (state) {
    // Update state from server response
    state.count = parseInt(el.dataset.count) || 0;
  }
});
</script>
```

### Loading States

```html
<div 
  data-hype-state='{ "loading": false }'
  data-hype-post="/api/data"
>
  <button 
    data-hype-on-click="set('loading', true); $fetch()"
    data-hype-bind-disabled="loading"
  >
    <span data-hype-show="!loading">Load Data</span>
    <span data-hype-show="loading">Loading...</span>
  </button>
</div>
```

---

## State Scope

State is scoped to the element with `data-hype-state` and its descendants:

```html
<div data-hype-state='{ "outer": true }'>
  <!-- Can access 'outer' -->
  <button data-hype-on-click="toggle('outer')">Toggle</button>
  
  <div data-hype-state='{ "inner": false }'>
    <!-- Can access 'inner' but NOT 'outer' -->
    <button data-hype-on-click="toggle('inner')">Toggle Inner</button>
  </div>
</div>
```

Child scopes create new contexts and cannot access parent state.

---

## JavaScript API

Access reactive state programmatically:

```javascript
import { hype } from 'hype';

// Get state for an element
const element = document.querySelector('#my-component');
const state = hype.reactive.getState(element);
console.log(state.count); // Access state values

// Update state
hype.reactive.setState(element, { count: 10 });

// Destroy reactive system for element
hype.reactive.destroy(element);
```

---

## Best Practices

### 1. Keep State Local
Define state close to where it's used:

```html
<!-- Good: local state -->
<div data-hype-state='{ "open": false }'>
  <button data-hype-on-click="toggle('open')">Toggle</button>
  <div data-hype-show="open">Content</div>
</div>

<!-- Avoid: distant state -->
<div data-hype-state='{ "modalOpen": false }'>
  <button data-hype-on-click="toggle('modalOpen')">Open</button>
  <div>
    <div>
      <div data-hype-show="modalOpen">Modal</div>
    </div>
  </div>
</div>
```

### 2. Use Semantic State Names

```html
<!-- Good -->
data-hype-state='{ "isExpanded": false, "isLoading": false }'

<!-- Avoid -->
data-hype-state='{ "flag1": false, "status": 0 }'
```

### 3. Combine with Server Requests

Leverage optimistic updates for better UX:

```html
<button 
  data-hype-state='{ "favorited": false }'
  data-hype-post="/api/favorite"
  data-hype-swap="none"
  data-hype-on-click="toggle('favorited'); $fetch()"
>
  <!-- Immediate visual feedback, then server sync -->
</button>
```

### 4. Avoid Complex Logic

Keep expressions simple. For complex logic, use server responses or event listeners:

```html
<!-- Good -->
<div data-hype-show="count > 0">

<!-- Avoid (too complex) -->
<div data-hype-show="(count > 0 && user.isAdmin) || (count > 10 && !user.isGuest)">
```

---

## Comparison with Alpine.js

Hype's reactive system is inspired by Alpine.js but tailored for server-rendered apps:

| Feature | Alpine.js | Hype Reactive |
|---------|-----------|---------------|
| State declaration | `x-data` | `data-hype-state` |
| Event handling | `@click` or `x-on:click` | `data-hype-on-click` |
| Show/hide | `x-show` | `data-hype-show` |
| Classes | `x-bind:class` | `data-hype-class-*` |
| Attributes | `x-bind:*` | `data-hype-bind-*` |
| Server requests | Via fetch | Built-in with `data-hype-post/get` |
| Models | `x-model` | Use `data-hype-on-input` + `set()` |

**Key differences:**
- Hype focuses on progressive enhancement with server integration
- No `x-model` - forms are meant to submit to servers
- Simpler directive syntax (no shorthand like `@` or `:`)
- Designed to work alongside traditional server rendering

---

## Performance

The reactive system is optimized for performance:

- **Proxy-based reactivity**: Efficient change detection
- **Targeted updates**: Only affected DOM elements update
- **No virtual DOM**: Direct DOM manipulation
- **Lazy evaluation**: Expressions only run when needed
- **Memory efficient**: WeakMap for element-to-state mapping

---

## Browser Support

Works in all modern browsers that support:
- Proxy (ES6)
- MutationObserver
- CustomEvent
- WeakMap

Supports: Chrome/Edge 49+, Firefox 18+, Safari 10+

---

## Debugging

Enable debug mode to see state changes:

```javascript
import { hype } from 'hype';

hype.configure({ debug: true });
hype.init();
```

This will log:
- State initialization
- State changes
- Directive evaluations
- Event handler calls

---

## FAQ

**Q: Can I use this with HTMX?**
A: Hype is an alternative to HTMX, but the reactive system could work alongside it. However, they have overlapping features.

**Q: Do I need a build step?**
A: No! Pure HTML attributes, works directly in the browser.

**Q: Can I nest state scopes?**
A: Yes, but child scopes cannot access parent state. Each `data-hype-state` creates an isolated scope.

**Q: How do I handle forms?**
A: Combine with Hype's form submission features. The reactive system handles UI state, Hype handles server communication.

**Q: Is this production-ready?**
A: The reactive system is a new addition. Test thoroughly before production use.

**Q: How does this differ from Vue/React?**
A: Much lighter weight, server-first, no virtual DOM or build step. Best for enhancing server-rendered HTML.

---

## Next Steps

- Try the [interactive examples](./reactive-examples.html)
- Read about [Hype's HTTP features](../README.md)
- Check out the [WebSocket live views](./live.md)