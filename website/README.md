# Strata website

The public site for Strata. Plain HTML, CSS and JavaScript with no build step.

## Deploy on Vercel

1. Import this repository in Vercel.
2. Set **Root Directory** to `website`.
3. Leave the framework preset as **Other**, with no build command and no output directory.

Every push to `main` that changes this folder then redeploys the site. Any other static host
works the same way: serve this folder as it is.

## Preview locally

```bash
python -m http.server 4173 --directory website
```

## What is here

- `index.html`, `styles.css`, `main.js`: the page.
- `vercel.json`: clean URLs and long-lived caching for the fonts.
- `fonts/`: Geist and Geist Mono (SIL Open Font License, see `fonts/OFL-Geist.txt`).
- Icons are from Phosphor Icons (MIT).

The pack shown under "Trust labels" is real `strata context` output from a two-commit demo
repository, trimmed.
