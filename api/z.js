// api/z.js — per-zone Open Graph route. vercel.json rewrites /z/:zone here;
// link scrapers (X, LinkedIn, Slack, Discord) read zone-specific OG/Twitter
// meta, humans are bounced straight to /?zone=<zone> (carried params like
// ?hour= and any utm_* tags ride along). ESM (the repo is "type": "module"),
// zero deps.
import { createHash } from 'node:crypto';

const SITE = 'https://island.digiscalability.com';

// og-cover-v3.jpg is rendered from the current build. Keep this alt text in
// step with index.html's og:image:alt and with what the image shows.
const OG_IMAGE = `${SITE}/og-cover-v3.jpg`;
const OG_IMAGE_ALT =
  'Life Island, a low-poly 3D island planet with a village, sea and a snow-capped mountain, captioned Abbas Ali, AI & software engineer.';

// Copy comes from the 2026-11-02 fact sheet. Titles stay within 60 characters
// and descriptions within 155 (test/claimsSurfaces.test.ts checks both).
const ZONES = {
  welcome: {
    title: 'Abbas Ali, AI & software engineer: Life Island',
    desc: 'A living 3D world (Three.js + TypeScript) where 24 villagers talk through Claude Haiku 4.5. Built solo by Abbas Ali, AI & software engineer, Melbourne.',
  },
  // The recruiter card. /?zone=hire opens the app's hire card only while
  // 'hire' is in openDeepLinkZone's allowlist (main-simple.ts); without it a
  // recruiter lands on the generic welcome instead.
  hire: {
    title: 'Abbas Ali — AI & software engineer, Melbourne',
    desc: 'CV, experience and contact for Abbas Ali, AI & software engineer in Melbourne, on Life Island: the 3D world he built and runs.',
  },
  professional: {
    title: 'Professional: Abbas Ali, AI & software engineer',
    desc: "Experience, stack and education of Abbas Ali, AI & software engineer in Melbourne, in Life Island's Professional district.",
  },
  projects: {
    title: 'Projects: Abbas Ali, AI & software engineer',
    desc: "Life Island, where 24 villagers talk through Claude Haiku 4.5, plus RankPilot (pre-launch), digiscalability.com and Bano's Cookbook.",
  },
  personal: {
    title: 'Personal: Abbas Ali, Life Island',
    desc: "The person behind the code: Abbas Ali's years as a Melbourne chef, his mother's handwritten recipes and the creative tools behind this world.",
  },
  contact: {
    title: 'Contact Abbas Ali: Life Island',
    desc: 'Hiring, or have a project? Email, LinkedIn and CV for Abbas Ali, AI & software engineer in Melbourne, or send a message from inside Life Island.',
  },
};

// Attribution tags survive the bounce so the app's entry capture
// (main-simple.ts, ds_entry) still sees them. Only utm_<letters> keys are
// carried, values are clipped, and nothing else from the query rides along.
const UTM_KEY = /^utm_[a-z]{1,20}$/;
const MAX_UTM = 8;

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A query value as one string: repeated keys arrive as arrays, keep the first. */
const first = (v) => (Array.isArray(v) ? first(v[0]) : typeof v === 'string' ? v : '');

export default function handler(req, res) {
  const q = req.query || {};
  const asked = first(q.zone).toLowerCase();
  const zone = Object.prototype.hasOwnProperty.call(ZONES, asked) ? asked : 'welcome';
  const z = ZONES[zone];

  // Rebuild the human-facing destination: /?zone=<zone>&<carried params>
  const dest = new URLSearchParams({ zone });
  for (const k of ['hour', 'theme']) {
    const v = first(q[k]);
    if (v) dest.set(k, v);
  }
  let utm = 0;
  for (const k of Object.keys(q)) {
    const v = first(q[k]);
    if (utm < MAX_UTM && UTM_KEY.test(k) && v) {
      dest.set(k, v.slice(0, 100));
      utm++;
    }
  }
  const destUrl = `/?${dest.toString()}`;
  const canonical = `${SITE}/z/${zone}`;
  // The page's only script is this redirect, so its own policy allows exactly
  // that script by hash and nothing else. The meta refresh still redirects if
  // a browser blocks the script. vercel.json leaves /z/ out of the site policy.
  const redirect = `location.replace(${JSON.stringify(destUrl)});`;
  const redirectHash = createHash('sha256').update(redirect).digest('base64');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'sha256-${redirectHash}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.status(200).send(`<!doctype html>
<html lang="en-AU"><head>
<meta charset="utf-8" />
<title>${esc(z.title)}</title>
<meta name="description" content="${esc(z.desc)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Life Island" />
<meta property="og:locale" content="en_AU" />
<meta property="og:title" content="${esc(z.title)}" />
<meta property="og:description" content="${esc(z.desc)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${OG_IMAGE}" />
<meta property="og:image:type" content="image/jpeg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${esc(OG_IMAGE_ALT)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@digiscalability" />
<meta name="twitter:title" content="${esc(z.title)}" />
<meta name="twitter:description" content="${esc(z.desc)}" />
<meta name="twitter:image" content="${OG_IMAGE}" />
<meta name="twitter:image:alt" content="${esc(OG_IMAGE_ALT)}" />
<meta http-equiv="refresh" content="0;url=${esc(destUrl)}" />
</head><body>
<script>${redirect}</script>
<p><a href="${esc(destUrl)}">Enter the island →</a></p>
</body></html>`);
}
