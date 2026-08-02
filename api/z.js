// api/z.js — per-zone Open Graph route. vercel.json rewrites /z/:zone here;
// link scrapers (X, LinkedIn, Slack, Discord) read zone-specific OG/Twitter
// meta, humans are bounced straight to /?zone=<zone> (carried params like
// ?hour= ride along). Plain CommonJS — zero deps, no build step.
const SITE = 'https://island.digiscalability.com';

const ZONES = {
  welcome: {
    title: 'DigiScalability Life Island',
    desc: 'A living 3D portfolio planet — walk it, race it, and talk to its AI townsfolk.',
  },
  professional: {
    title: 'Professional District — Life Island',
    desc: "Abbas Ali's full-stack + AI engineering story, told as a walkable 3D district.",
  },
  projects: {
    title: 'Projects District — Life Island',
    desc: 'RankPilot, ChocoMate and more — ventures under construction on a living 3D planet.',
  },
  personal: {
    title: 'Personal District — Life Island',
    desc: 'The human behind the code — cottages, stories, and sleeping AI townsfolk.',
  },
  contact: {
    title: 'Get In Touch — Life Island',
    desc: 'Walk into the Post Office and send Abbas a real message from inside a 3D world.',
  },
};

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

module.exports = (req, res) => {
  const q = req.query || {};
  const zone = Object.prototype.hasOwnProperty.call(ZONES, String(q.zone || '').toLowerCase())
    ? String(q.zone).toLowerCase()
    : 'welcome';
  const z = ZONES[zone];

  // Rebuild the human-facing destination: /?zone=<zone>&<carried params>
  const dest = new URLSearchParams({ zone });
  for (const k of ['hour', 'theme']) {
    if (typeof q[k] === 'string' && q[k]) dest.set(k, q[k]);
  }
  const destUrl = `/?${dest.toString()}`;
  const canonical = `${SITE}/z/${zone}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${esc(z.title)}</title>
<meta name="description" content="${esc(z.desc)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="DigiScalability Life Island" />
<meta property="og:title" content="${esc(z.title)}" />
<meta property="og:description" content="${esc(z.desc)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${SITE}/og-cover-v2.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(z.title)}" />
<meta name="twitter:description" content="${esc(z.desc)}" />
<meta name="twitter:image" content="${SITE}/og-cover-v2.jpg" />
<meta name="twitter:image:alt" content="A miniature 3D island planet with a village, seen from above at golden hour" />
<meta http-equiv="refresh" content="0;url=${esc(destUrl)}" />
</head><body>
<script>location.replace(${JSON.stringify(destUrl)});</script>
<p><a href="${esc(destUrl)}">Enter the island →</a></p>
</body></html>`);
};
