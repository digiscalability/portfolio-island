// Claims guard for the in-app copy (the 2026-11-02 copy pass).
//
// Retired lines from earlier in-app copy; none may come back, and every
// count must match the code.
//
// Source text, not imports: the copy lives in template strings, and a banned
// phrase in a comment is still one paste away from the page.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const FILES = ['SimpleUI.ts', 'main-simple.ts', 'ReceptionDesk.ts', 'NpcChat.ts'] as const;
const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');

// Case-insensitive.
const BANNED = [
  'in daily use',
  'nearly done',
  'Day job in tech',
  'grandmother',
  'in/digiscalability',
  '18 conversational',
  // fact-sheet rules: one person, no agency language, no "senior"
  'venture studio',
  'our team',
  'delivery team',
  'growing teams',
  'agency',
  'senior',
  // villagers are LLM chat characters; the agents are the planner and analyst
  'live AI villager',
  'conversational agents',
];

describe('banned claims never reach the in-app copy', () => {
  for (const f of FILES) {
    test(f, () => {
      const s = src(f).toLowerCase();
      const hits = BANNED.filter((p) => s.includes(p.toLowerCase()));
      expect(hits, `${f} contains banned copy`).toEqual([]);
      // "Open source (MIT)" holds only while the MIT LICENSE is in the repo.
      if (existsSync(join(process.cwd(), 'LICENSE'))) {
        expect(src('LICENSE')).toMatch(/^MIT License\n/);
      } else {
        expect(src(f), `${f} says "open source" with no LICENSE`).not.toMatch(/open[- ]source/i);
      }
      // A phone number is guarded by its shape, never by its value: this repo
      // is public, so a guard that spelled the number out would publish it.
      expect(src(f), f).not.toMatch(
        /(?:\+61\s?|\b0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}\b|\+61[\s-]?\(?\d/,
      );
    });
  }
});

describe('the approved lines are the ones shipped', () => {
  const ui = src('SimpleUI.ts');

  test('RankPilot: live, pre-launch, demoted to a secondary demo link', () => {
    expect(ui).toContain('live, pre-launch: no users beyond test accounts');
    expect(ui).not.toContain('Visit RankPilot');
    const demo = ui.split('\n').find((l) => l.includes("'↗ Pre-launch demo'"));
    expect(demo, 'Pre-launch demo link missing').toBeTruthy();
    expect(demo).not.toContain('primary: true');
  });

  test('education carries the credit count; Bano’s is his mother’s; ChocoMate is paused', () => {
    expect(ui).toContain('11 of 16 credit points');
    expect(ui).toContain("my mother's (Ammi's) handwritten recipes from 1981");
    expect(ui).toMatch(/ChocoMate[^\n]*● paused/);
  });

  test('the About panel calls the island Abbas’s portfolio', () => {
    const i = ui.indexOf('welcome: `');
    expect(i).toBeGreaterThan(-1);
    expect(ui.slice(i, i + 600)).toContain("Abbas Ali's portfolio");
  });

  test('the AI-agent count is derived from the roster, never typed', () => {
    // (main-simple.ts's own roster-derived count is package A's mainLocks; the
    // typed-count scan below is a content scan and stays: testOwnership rule 3)
    expect(ui).toContain('Object.keys(AI_NPCS).length');
    for (const f of FILES) {
      expect(src(f), f).not.toMatch(/\b\d+ (conversational agents|villagers talk|townsfolk are)/);
    }
  });

  test('the bundle-size line is the measured one', () => {
    expect(ui).toContain('~280 KB app + 175 KB three.js (brotli)');
    expect(ui).not.toMatch(/~300 ?KB/);
  });
});

describe('identity links point at Abbas, not the brand', () => {
  const ui = src('SimpleUI.ts');

  test('one OWNER table: personal LinkedIn, the island repo, the web CV', () => {
    expect(ui).toContain("linkedin: 'https://www.linkedin.com/in/-abbas-ali'");
    expect(ui).toContain("repo: 'https://github.com/digiscalability/portfolio-island'");
    expect(ui).toContain("cv: 'https://digiscalability.com/about'");
  });

  test('no button opens the bare GitHub org profile or the RankPilot mirror', () => {
    for (const f of FILES) {
      expect(src(f), f).not.toMatch(/['"`]https:\/\/github\.com\/digiscalability['"`]/);
      expect(src(f), f).not.toContain('github.com/digiscalability/rankpilot');
      expect(src(f), f).not.toMatch(/rizz-vii/i);
    }
  });

  test('the contact footer no longer claims every channel is @digiscalability', () => {
    expect(ui).not.toContain('All channels @digiscalability');
  });
});

describe('the availability line appears on the hire card only', () => {
  const LINE = 'Open to AI and software engineering roles in Melbourne (full-time or contract).';

  test('exactly once in SimpleUI.ts, inside the hire card', () => {
    const ui = src('SimpleUI.ts');
    expect(ui.split(LINE).length - 1).toBe(1);
    const hire = ui.indexOf('hire: `');
    expect(hire).toBeGreaterThan(-1);
    expect(ui.indexOf(LINE)).toBeGreaterThan(hire);
  });

  test('never in main-simple.ts, ReceptionDesk.ts or NpcChat.ts', () => {
    for (const f of ['main-simple.ts', 'ReceptionDesk.ts', 'NpcChat.ts']) {
      expect(src(f), f).not.toContain('Open to AI and software engineering roles');
    }
  });
});

describe('copy elsewhere in the funnel', () => {
  test('the receptionist promises only what its agent is set up to answer', () => {
    // The voice agent's prompt lives in ElevenLabs, outside this repo, and is
    // a business receptionist (projects, prices). Until it carries the fact
    // sheet's experience and education, the copy invites work and projects.
    const desk = src('ReceptionDesk.ts');
    expect(desk).toContain('ask it about my work, or your project.');
    expect(desk).not.toMatch(/ask it about my experience|my stack/);
  });

  test('the lead form speaks to hiring as well as projects', () => {
    expect(src('SimpleUI.ts')).toContain('placeholder="A role, a project, or a question"');
  });
});

describe('repo links land where they say', () => {
  // GitHub's heading anchors: lowercased, punctuation dropped, spaces to '-'.
  const slug = (heading: string): string =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');

  test('every ${OWNER.repo}#anchor names a real README heading', () => {
    const anchors = [...src('SimpleUI.ts').matchAll(/\$\{OWNER\.repo\}#([\w-]+)/g)].map(
      (m) => m[1],
    );
    expect(anchors.length).toBeGreaterThan(0);
    const headings = src('README.md')
      .split('\n')
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => slug(l.replace(/^#{1,6} /, '')));
    for (const a of anchors) expect(headings, `#${a}`).toContain(a);
  });

  test('the Insta Services entry carries no island-repo button', () => {
    const ui = src('SimpleUI.ts');
    const i = ui.indexOf('🧰 Insta Services API</h3>');
    expect(i).toBeGreaterThan(-1);
    const entry = ui.slice(i, ui.indexOf('</p>', i));
    expect(entry).not.toContain('OWNER.repo');
  });
});
