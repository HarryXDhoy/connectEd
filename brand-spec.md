# connectEd visual blend

Source: `HarryXDhoy/connectEd` → `DESIGN.md`, `brand.json`, and `collaboration-landing.html`.

The landing language combines Apple’s calm product polish with connectEd’s practical collaboration workflow: white canvas, soft-gray product surfaces, SF Pro typography, 8px geometry, restrained blue interaction color, and a light grid that makes the dashboard feel like a live system.

```css
:root {
  --bg: #ffffff;
  --surface: #f5f5f5;
  --fg: #000000;
  --muted: #8c8c8c;
  --border: #dbdbdb;
  --accent: #0066cc;
  --accent-secondary: #2997ff;
  --font-display: "SF Pro HK", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --font-body: "SF Pro HK", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
```

Observed posture rules:

- Keep the canvas white and use `#f5f5f5` for raised product surfaces.
- Use 8px radii and an 8px spacing baseline.
- Let blue carry action, status, and emphasis; keep the rest quiet.
- Pair a live product frame with concise product language rather than decorative illustration.
- Use subtle grid, reveal, and depth motion to make the system feel active without becoming theatrical.
