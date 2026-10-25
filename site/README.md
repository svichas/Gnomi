# Gnomi marketing site

A minimal, single-page marketing site, built with HTML, CSS, vanilla JavaScript, and Vite. No framework or runtime dependencies.

## Development

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

Vite prints the local preview URL. To create and preview the static production build:

```sh
npm run build
npm run preview
```

Deploy the contents of `dist/` to any static host. The relative base supports hosting under a subdirectory.

This site is published from the parent Gnomi repository to GitHub Pages via [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml), which builds `site/dist` and force-pushes it to the `gh-pages` branch. GitHub Pages serves that branch at <https://svichas.github.io/Gnomi/>. No separate hosting setup is required.

## Content and assets

- `index.html`: page copy, navigation, video, transcript, and external links.
- `src/style.css`: responsive layout using the supplied brand tokens.
- `src/main.js`: progressive enhancement of the video play button.
- `public/brand/`: supplied Gnomi artwork, tokens, and local Inter font with its OFL license.
- `public/media/Gnomi-master.mp4`: exact supplied master video (1:48).
- `public/media/film-poster.jpg`: frame extracted from the supplied master at 1:00.
- `public/media/Gnomi.en.vtt`: the supplied English SRT converted to WebVTT.

The hero loads a poster first and plays only on request. Native video controls, captions, and a text transcript are available. The page remains usable without JavaScript. The GitHub setup guide is the CTA destination because the product currently runs from source; update the two get-started links when a public download or onboarding URL is available.

## Design contract

Introduce Gnomi to product teams and lead visitors to the film or source setup guide. Follow `Gnomi/docs/brand.md`: Paper, Ink, Olive and Sage, local Inter, supplied logos, quiet rules, and restrained corners. Use the official film as the main visual. Preserve the distinction between simulated findings and human research; omit invented metrics, testimonials, pricing, and customer logos.

Responsive targets: 320, 768, 1024, and 1440 px. Interactive controls must work with keyboard focus. Respect reduced motion; never autoplay. Show a direct-video fallback when playback fails.

Implementation references: [Vite guide](https://vite.dev/guide/) and [HTML video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video).
