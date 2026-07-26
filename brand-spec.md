# connectEd — Supabase visual system

The product now uses a dark, code-first Supabase posture: near-black canvas, border-defined surfaces, restrained emerald signals, and dense but calm product typography.

## Core tokens

```css
--bg: oklch(0.205 0 0);
--surface: oklch(0.226 0 0);
--fg: oklch(0.985 0 0);
--muted: oklch(0.627 0 0);
--border: oklch(0.297 0 0);
--accent: oklch(0.778 0.139 164);
```

## Type

- Display and body: `"Circular", "custom-font", "Helvetica Neue", Helvetica, Arial, sans-serif`
- Technical labels: `"Source Code Pro", "Office Code Pro", Menlo, Monaco, Consolas, monospace`
- Regular weight carries the hierarchy; medium weight is reserved for navigation and controls.

## Posture

- Near-black surfaces are separated by one-pixel border steps, not decorative shadows.
- Emerald appears on the brand mark, primary action, active state, or technical status—not as a large wash.
- Primary actions and tabs use pills; secondary controls use a compact 6px radius.
- The project board is a uniform responsive grid, with database-console density rather than Pinterest masonry.
- Motion confirms spatial state only; transforms are removed when reduced motion is requested.
