# Gnomi site

The public page at <https://svichas.github.io/Gnomi/>, served by GitHub Pages straight from this branch. Plain HTML, CSS and JavaScript with no build step: edit the files here and push.

- `index.html`: copy and links.
- `style.css`: layout, using the brand tokens in `brand/brand-tokens.css`, with dark mode from the system setting.
- `main.js`: loads the YouTube introduction only when it is played, and the copy button on the quick start.
- `brand/`: logos, the local Inter font and its license, and the social preview image.

Preview locally with `python3 -m http.server` from this folder.

Keep the copy honest about simulation: findings are hypotheses, not facts about real users. No invented metrics, testimonials or customer logos. See `docs/brand.md` on `main`.
