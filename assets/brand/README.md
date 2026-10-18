# Gnomi brand assets

The design rules and rationale live in [docs/brand.md](../../docs/brand.md). Start with the [visual board](brand-board.png).

| File | Format / dimensions | Purpose |
|---|---|---|
| [gnomi-logo.svg](gnomi-logo.svg) | SVG · 260 × 80 | Primary Olive symbol + Ink wordmark, transparent |
| [gnomi-logo-mono.svg](gnomi-logo-mono.svg) | SVG · 260 × 80 | Ink artwork, transparent |
| [gnomi-logo-light.svg](gnomi-logo-light.svg) | SVG · 260 × 80 | Sage symbol + Paper wordmark, transparent; GitHub dark mode and dark surfaces |
| [gnomi-logo-reversed.svg](gnomi-logo-reversed.svg) | SVG · 260 × 80 | Paper artwork, transparent; place on Ink or Olive |
| [gnomi-wordmark.svg](gnomi-wordmark.svg) | SVG · 180 × 80 | Ink lowercase wordmark, transparent |
| [gnomi-logo.png](gnomi-logo.png) | PNG · 1040 × 320 | Primary logo at 4× resolution, transparent |
| [gnomi-icon.svg](gnomi-icon.svg) | SVG · 64 × 64 | Olive standalone opinion mark, transparent |
| [gnomi-icon-mono.svg](gnomi-icon-mono.svg) | SVG · 64 × 64 | Ink standalone mark, transparent |
| [gnomi-icon-reversed.svg](gnomi-icon-reversed.svg) | SVG · 64 × 64 | Paper standalone mark, transparent |
| [gnomi-icon.png](gnomi-icon.png) | PNG · 512 × 512 | Olive standalone mark, transparent |
| [gnomi-app-icon.svg](gnomi-app-icon.svg) | SVG · 1024 × 1024 | Olive rounded tile with Paper mark; transparent outside tile |
| [gnomi-app-icon.png](gnomi-app-icon.png) | PNG · 1024 × 1024 | Launcher artwork export |
| [favicon.ico](favicon.ico) | ICO · 16, 32, 48 px | Olive mark, transparent; light browser contexts |
| [brand-board.svg](brand-board.svg) | SVG · 1600 × 1300 | Self-contained visual brand board, outlined typography |
| [brand-board.png](brand-board.png) | PNG · 1600 × 1300 | Shareable brand board preview |
| [brand-tokens.css](brand-tokens.css) | CSS | Font declaration, light/dark color roles, typography and spacing references |
| [fonts/InterVariable.woff2](fonts/InterVariable.woff2) | WOFF2 · Inter 4.001 | Local upright variable font, weights 100–900 |
| [fonts/OFL.txt](fonts/OFL.txt) | Text | Inter’s SIL Open Font License 1.1 |

SVGs are the editable masters. The logo uses outlined Inter Medium lettering with adjusted tracking; it has no live text or external font dependency. The standalone symbol is one stroked path. Keep its rounded caps and joins when editing or converting it to outlines. The board is also fully outlined and can be viewed offline.

For an accessible image, use `alt="Gnomi"` on the logo. When a logo is the only content in a home link, give the link a destination label such as “Gnomi home.” Decorative duplicates should have empty alt text. Reversed files need a dark background to be visible.

The app icon is source artwork, not an installer configuration. Generate platform-required icon containers and masking variants from the SVG or 1024 px PNG when packaging the desktop app. For a dark browser tab, use the reversed SVG icon instead of the Olive ICO.

## Font provenance

- Family: [Inter](https://rsms.me/inter/), by the Inter Project Authors.
- File version: `Version 4.001;git-9221beed3`.
- Unmodified source downloaded 2026-10-15: [InterVariable.woff2](https://raw.githubusercontent.com/rsms/inter/master/docs/font-files/InterVariable.woff2).
- License source: [upstream OFL](https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt); a complete copy ships beside the font.
- SHA-256: `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`.

Ship the font with its license. The SVG lettering remains stable even when a user has a different Inter version installed.
