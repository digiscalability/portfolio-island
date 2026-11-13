# Credits

What the deployed island is made of, and where each part came from. Checked
against the files in this repo on 2026-11-02.

The code in this repo is open source under the MIT License (see
[LICENSE](LICENSE)). Third-party models, textures, fonts and other assets keep
their own licences, listed below.

## 3D models

`public/assets/models/*.glb` (bench, lamp, mailbox, npc, player, rock, tree)
were authored in Blender for this project. The player and villager avatars are
then reshaped by the headless Blender scripts in `scripts/*.py`, which keep the
inputs they start from in `scripts/backup/`. No third-party mesh ships.

`Island.ts` also lists models from three free Quaternius kits (Fantasy Props
MegaKit, Stylized Nature MegaKit and Universal Base Characters, the Standard
editions) under `/assetKits/`, tried only when an authored model fails to load.
That folder is git-ignored and is neither committed nor deployed, so those
requests fail too and the procedural geometry stays. The kits are released
under CC0 1.0 (public domain); models by [Quaternius](https://quaternius.com).

## Fonts

Self-hosted in `public/fonts/` (the Latin subsets, as WOFF2, taken from the
Fontsource 5.2.5 packages of the Google Fonts releases), both under the SIL
Open Font License 1.1, whose text ships beside them as `public/fonts/OFL.txt`:

- Bebas Neue by Ryoichi Tsunekawa (`bebas-neue-latin.woff2`)
- Patrick Hand by Patrick Wagesreiter (`patrick-hand-latin.woff2`)

The page makes no request to Google Fonts. While Bebas Neue loads, titles
use a local Arial Narrow or Arial scaled to its metrics ('Bebas Neue
Fallback'); nothing from those system fonts is redistributed.

## Sound and voice

- Sound effects and the background music are synthesised in the browser with
  the Web Audio API (`Sfx.ts`, and `startBackgroundMusic` in `main-simple.ts`);
  no recorded audio is in the repo.
- Villager voices are generated on request by ElevenLabs text-to-speech through
  the `npcVoice` function; the browser's own speech synthesis is the fallback.

## Images and video

The social cards (`public/og-cover*.jpg`) and `public/launch-clip.mp4` are
renders and captures of the island itself. The favicon and app icons are a
simple drawing of the planet made for this project. The two project panels in
`public/assets/panels/` are screenshots of Abbas Ali's own sites, RankPilot and
ChocoMate.

## Code

Open-source packages are listed in `package.json` and `functions/package.json`,
each under its own licence: three.js, three-mesh-bvh, the ElevenLabs client,
Vercel Analytics and the Anthropic SDK (MIT), the Firebase JS SDK and
firebase-admin (Apache-2.0), firebase-functions (MIT) and Nodemailer (MIT-0).
