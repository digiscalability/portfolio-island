Asset workflow and placeholder generator

This project includes small scripts to generate placeholder assets and to help
download freely-licensed assets for local testing.

Available scripts:

- `node ./scripts/gen-placeholders.js` — creates SVG placeholders and a tiny
  `.gltf` + `.bin` cube placeholder under `assets/placeholders/`.
- `./scripts/download-assets.ps1` — PowerShell script to fetch a small curated
  set of HDRIs and audio samples into `assets/`. Run locally in PowerShell.
- `npm run generate:placeholders` — npm wrapper for the generator.

Usage (PowerShell):

```powershell
npm run generate:placeholders
./scripts/download-assets.ps1
```

Notes:
- Download scripts must be run locally; they are provided for convenience and
  will not be executed by the repository automatically.
- When adding large or third-party assets to the repo, verify the license and
  consider referencing them in `CREDITS.md` if attribution is required.

Next steps available on request:
- Add curated CC0 asset lists and expand `download-assets.ps1`.
- Add a Node-based downloader that works cross-platform and verifies checksums.
