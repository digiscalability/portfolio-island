/**
 * analyst — the nightly "chief of staff". Aggregates ONLY truthful, server-
 * readable island metrics (RTDB), snapshots them for day-over-day deltas, has
 * Claude write the owner a private prose digest + concrete improvement
 * proposals, emails it (reusing the lead-mail SMTP path), files the top
 * proposals as GitHub ISSUES (never code edits), and publishes a safe,
 * counts-only, index-selected public notice for the in-world "Island Times".
 *
 * Truthful-only: Vercel Analytics events are client-only and unreadable here, so
 * traffic / funnel / dwell are NEVER asserted. Free prose is confined to the
 * owner email + issue bodies (owner-only surfaces); the public notice is numbers
 * + pre-authored template indices only.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const SMTP_PASSWORD = defineSecret('SMTP_PASSWORD');
const GITHUB_TOKEN = defineSecret('GITHUB_TOKEN');

// Reuse the same operator SMTP config the lead mailer uses (functions/.env).
const SMTP_HOST = defineString('SMTP_HOST');
const SMTP_PORT = defineString('SMTP_PORT');
const SMTP_USER = defineString('SMTP_USER');
const LEAD_FROM = defineString('LEAD_FROM');
const LEAD_TO = defineString('LEAD_TO');
// Optional owner override for the digest recipient. Defaults to '' so it needs
// no .env entry and resolves in non-interactive deploys; the runtime falls back
// to LEAD_TO whenever it's blank (see the sendMail `to:` below).
const ANALYST_TO = defineString('ANALYST_TO', { default: '' });

const GITHUB_REPO = 'digiscalability/portfolio-island';
const ANALYST_TOKEN_CAP = 4_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Issue-filing throttles. Title-dedupe alone can't bound the backlog because the
// LLM re-words equivalent proposals every night (the key drifts), so we bound the
// EFFECT: never file within the cooldown window, and never exceed the open cap.
// The digest email + public notice are unaffected — only issue creation throttles.
const ISSUE_COOLDOWN_MS = 3 * DAY_MS; // ≤ one filing burst per 3 days
const MAX_OPEN_ISSUES = 5; // hard ceiling on open island-analyst issues

// Public board lines (indexable, pre-authored + safe). The client holds an
// identical copy (SimpleUI); the analyst only ever sends indices into this list.
export const NOTICE_TEMPLATES = [
  'A steady day on the island.', // 0
  'New faces arrived from across the sea.', // 1
  'The racing circuits saw fresh records.', // 2
  'The guestbook gained some kind words.', // 3
  'The market and plazas were busy today.', // 4
  'A quiet, restful day in the districts.', // 5
  'The couriers had a full postbag.', // 6
  'Word of the island is spreading.', // 7
];

const headerSafe = (v: unknown, max = 200): string =>
  String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, max);

async function countLivePresence(db: admin.database.Database, now: number): Promise<number> {
  const val = (await db.ref('presence/island').get()).val() as Record<string, { t?: number }> | null;
  if (!val) return 0;
  let live = 0;
  for (const e of Object.values(val)) if (now - (typeof e?.t === 'number' ? e.t : 0) <= 2 * 60 * 1000) live++;
  return live;
}

interface Metrics {
  online: number;
  leadsTotal: number;
  leadsNew: number;
  guestbookTotal: number;
  guestbookNew: number;
  guestbookLines: string[]; // day's new notes — owner email ONLY
  racersTotal: number;
  racePBsNew: number;
  fastest: Array<{ circuit: string; name: string; timeMs: number }>;
  activeDevices: number;
  devicesTotal: number;
  aiTokensMonth: number;
  aiCallsMonth: number;
  aiTokensDay: number;
  aiIps24h: number;
  aiBurstHits: number;
  mood: string;
}

async function gather(db: admin.database.Database, now: number, month: string, day: string): Promise<Metrics> {
  const since = now - DAY_MS;
  const [leads, gb, lb, profiles, world, aiTok, aiCalls, aiDay, aiRate] = await Promise.all([
    db.ref('leads/island').get(),
    db.ref('guestbook/island').get(),
    db.ref('leaderboard/island').get(),
    db.ref('profiles').get(),
    db.ref('world/island').get(),
    db.ref(`aiUsage/${month}/tokens`).get(),
    db.ref(`aiUsage/${month}/calls`).get(),
    db.ref(`aiUsage/${month}/daily/${day}/tokens`).get(),
    db.ref('aiRate').get(),
  ]);

  const leadV = (leads.val() as Record<string, { t?: number }>) ?? {};
  const gbV = (gb.val() as Record<string, { t?: number; name?: string; msg?: string }>) ?? {};
  const gbLines: string[] = [];
  let guestbookNew = 0;
  for (const e of Object.values(gbV)) {
    if ((e.t ?? 0) >= since) {
      guestbookNew++;
      gbLines.push(`${headerSafe(e.name, 40) || 'someone'}: ${headerSafe(e.msg, 200)}`);
    }
  }

  const fastest: Metrics['fastest'] = [];
  let racersTotal = 0;
  let racePBsNew = 0;
  const lbV = (lb.val() as Record<string, Record<string, { name?: string; timeMs?: number; t?: number }>>) ?? {};
  for (const [circuit, byUid] of Object.entries(lbV)) {
    let best: { name: string; timeMs: number } | null = null;
    for (const rec of Object.values(byUid)) {
      racersTotal++;
      if ((rec.t ?? 0) >= since) racePBsNew++;
      if (typeof rec.timeMs === 'number' && (!best || rec.timeMs < best.timeMs)) {
        best = { name: headerSafe(rec.name, 40) || 'anonymous', timeMs: rec.timeMs };
      }
    }
    if (best) fastest.push({ circuit, ...best });
  }

  const profV = (profiles.val() as Record<string, { t?: number }>) ?? {};
  let activeDevices = 0;
  for (const e of Object.values(profV)) if ((e.t ?? 0) >= since) activeDevices++;

  const rateV = (aiRate.val() as Record<string, { t?: number; c?: number }>) ?? {};
  let aiIps24h = 0;
  let aiBurstHits = 0;
  for (const e of Object.values(rateV)) {
    if ((e.t ?? 0) >= since) aiIps24h++;
    if ((e.c ?? 0) > 8) aiBurstHits++;
  }

  const worldV = (world.val() as { mood?: string }) ?? {};

  return {
    online: await countLivePresence(db, now),
    leadsTotal: Object.keys(leadV).length,
    leadsNew: Object.values(leadV).filter((e) => (e.t ?? 0) >= since).length,
    guestbookTotal: Object.keys(gbV).length,
    guestbookNew,
    guestbookLines: gbLines.slice(0, 12),
    racersTotal,
    racePBsNew,
    fastest,
    activeDevices,
    devicesTotal: Object.keys(profV).length,
    aiTokensMonth: (aiTok.val() as number | null) ?? 0,
    aiCallsMonth: (aiCalls.val() as number | null) ?? 0,
    aiTokensDay: (aiDay.val() as number | null) ?? 0,
    aiIps24h,
    aiBurstHits,
    mood: typeof worldV.mood === 'string' ? worldV.mood : 'unknown',
  };
}

// Rule-based public notice: numbers + pre-authored line indices only (no LLM).
function buildNotice(m: Metrics): { lines: number[]; counts: Record<string, number> } {
  const lines: number[] = [];
  if (m.leadsNew > 0) lines.push(1);
  if (m.racePBsNew > 0) lines.push(2);
  if (m.guestbookNew > 0) lines.push(3);
  if (m.activeDevices >= 5) lines.push(4);
  else if (m.activeDevices <= 1) lines.push(5);
  if (m.aiIps24h >= 3) lines.push(7);
  if (!lines.length) lines.push(0);
  return {
    lines: lines.slice(0, 4),
    counts: {
      visitors: m.activeDevices,
      leads: m.leadsTotal,
      guestbook: m.guestbookTotal,
      races: m.racersTotal,
      online: m.online,
    },
  };
}

function plainDigest(m: Metrics, deltas: Record<string, number> | null): string {
  const d = (k: string) => (deltas && k in deltas ? ` (${deltas[k] >= 0 ? '+' : ''}${deltas[k]})` : '');
  const lines = [
    `Portfolio Island — daily report`,
    ``,
    `Visitors (active devices, 24h): ${m.activeDevices}${d('activeDevices')}   |   live now: ${m.online}`,
    `Devices all-time: ${m.devicesTotal}${d('devicesTotal')}`,
    `Leads: ${m.leadsNew} new, ${m.leadsTotal} total${d('leadsTotal')}`,
    `Guestbook: ${m.guestbookNew} new, ${m.guestbookTotal} total${d('guestbookTotal')}`,
    `Racing: ${m.racePBsNew} PBs today, ${m.racersTotal} racers total`,
    ...m.fastest.map((f) => `  · ${f.circuit}: ${(f.timeMs / 1000).toFixed(2)}s by ${f.name}`),
    `AI chat: ${m.aiCallsMonth} calls / ${m.aiTokensMonth.toLocaleString()} tokens this month (${((m.aiTokensMonth / ANALYST_TOKEN_CAP) * 100).toFixed(1)}% of cap); ${m.aiIps24h} IPs in 24h; ${m.aiBurstHits} burst-limit hits`,
    `World mood: ${m.mood}`,
  ];
  if (m.guestbookLines.length) {
    lines.push('', "Today's guestbook notes:", ...m.guestbookLines.map((l) => `  “${l}”`));
  }
  return lines.join('\n');
}

const normTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

async function fileGithubIssues(
  db: admin.database.Database,
  token: string,
  proposals: Array<{ title: string; body: string }>,
  now: number,
): Promise<number> {
  if (!token || !proposals.length) return 0;

  // Cooldown: don't file if we filed within the window. This is the primary
  // guard against nightly accretion — the LLM re-words equivalent proposals so
  // title-dedupe can't catch them; a time gate bounds the rate regardless.
  // (stats/* is unlisted ⇒ Admin-SDK-only, same as stats/daily.)
  const metaRef = db.ref('stats/analystIssues/lastFiledTs');
  const lastFiledTs = ((await metaRef.get()).val() as number | null) ?? 0;
  if (now - lastFiledTs < ISSUE_COOLDOWN_MS) {
    console.log(`analyst issues: cooldown (filed ${((now - lastFiledTs) / DAY_MS).toFixed(1)}d ago), skipped`);
    return 0;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'island-analyst',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Fetch open analyst issues for BOTH the backlog cap and title-dedupe.
  let openTitles = new Set<string>();
  let openCount = 0;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/issues?state=open&labels=island-analyst&per_page=100`,
      { headers },
    );
    if (res.ok) {
      const list = (await res.json()) as Array<{ title?: string; pull_request?: unknown }>;
      const issuesOnly = list.filter((i) => !i.pull_request); // the issues API includes PRs
      openCount = issuesOnly.length;
      openTitles = new Set(issuesOnly.map((i) => normTitle(i.title ?? '')));
    } else {
      // Can't read the backlog ⇒ don't risk spamming; skip this run.
      console.error('ALERT analyst-github-failed', { status: res.status, at: 'list' });
      return 0;
    }
  } catch (e) {
    console.error('ALERT analyst-github-failed', { msg: (e as Error).message, at: 'list' });
    return 0;
  }

  const slots = Math.max(0, MAX_OPEN_ISSUES - openCount);
  if (slots === 0) {
    console.log(`analyst issues: backlog at cap (${openCount}/${MAX_OPEN_ISSUES}), skipped`);
    return 0;
  }

  let filed = 0;
  for (const p of proposals.slice(0, 2)) {
    if (filed >= slots) break;
    const title = `[island] ${headerSafe(p.title, 120)}`;
    if (openTitles.has(normTitle(title))) continue;
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body: `${String(p.body).slice(0, 4000)}\n\n---\n_Auto-filed by the island analyst from the nightly report. Review before acting; nothing is applied automatically._`,
          labels: ['island-analyst'],
        }),
      });
      if (res.ok) filed++;
      else console.error('ALERT analyst-github-failed', { status: res.status, at: 'create' });
    } catch (e) {
      console.error('ALERT analyst-github-failed', { msg: (e as Error).message, at: 'create' });
    }
  }
  // Record the filing so the cooldown starts from a SUCCESSFUL burst only.
  if (filed > 0) await metaRef.set(now);
  return filed;
}

export const analyst = onSchedule(
  {
    schedule: '0 21 * * *', // 9pm daily
    timeZone: 'Australia/Melbourne',
    region: 'us-central1',
    secrets: [ANTHROPIC_API_KEY, SMTP_PASSWORD, GITHUB_TOKEN],
    timeoutSeconds: 300,
    memory: '256MiB',
  },
  async () => {
    const db = admin.database();
    const now = Date.now();
    const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    const month = day.slice(0, 7);
    const yesterday = new Date(now - DAY_MS).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });

    const m = await gather(db, now, month, day);

    // Snapshot for tomorrow's deltas; read yesterday's for today's deltas.
    const prev = (await db.ref(`stats/daily/${yesterday}`).get()).val() as Metrics | null;
    const deltas: Record<string, number> | null = prev
      ? {
          activeDevices: m.activeDevices - (prev.activeDevices ?? 0),
          devicesTotal: m.devicesTotal - (prev.devicesTotal ?? 0),
          leadsTotal: m.leadsTotal - (prev.leadsTotal ?? 0),
          guestbookTotal: m.guestbookTotal - (prev.guestbookTotal ?? 0),
        }
      : null;
    // Snapshot without the raw guestbook text (keep the store lean + PII-light).
    await db.ref(`stats/daily/${day}`).set({ ...m, guestbookLines: [], t: now });

    // Owner digest + proposals via one Claude call. Free prose allowed here
    // (owner-only). Any failure ⇒ still email the deterministic metrics digest.
    let digest = plainDigest(m, deltas);
    let proposals: Array<{ title: string; body: string }> = [];
    let usedNow = 0;
    if (m.aiTokensMonth < ANALYST_TOKEN_CAP) {
      try {
        const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
        const resp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 900,
          system:
            'You are the analyst for "Portfolio Island", the interactive 3D portfolio of Abbas, a solo founder. Write a short, friendly owner-facing daily report from the metrics, then propose 0-3 concrete, small improvements to the site/repo. Only use the numbers given; never invent traffic or events not present. Reply as minified JSON: {"digest":"<plain text report>","proposals":[{"title":"...","body":"..."}]}.',
          messages: [{ role: 'user', content: `Metrics JSON:\n${JSON.stringify({ ...m, guestbookLines: undefined })}\nDeltas vs yesterday:\n${JSON.stringify(deltas)}` }],
        });
        usedNow = (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);
        const block = resp.content.find((b) => b.type === 'text');
        const text = block && 'text' in block ? block.text : '';
        const jm = text.match(/\{[\s\S]*\}/);
        if (jm) {
          const parsed = JSON.parse(jm[0]) as { digest?: string; proposals?: Array<{ title?: string; body?: string }> };
          if (typeof parsed.digest === 'string' && parsed.digest.length > 20) {
            digest = `${parsed.digest}\n\n— — —\n${plainDigest(m, deltas)}`;
          }
          if (Array.isArray(parsed.proposals)) {
            proposals = parsed.proposals
              .filter((p) => p && typeof p.title === 'string' && typeof p.body === 'string')
              .map((p) => ({ title: p.title as string, body: p.body as string }));
          }
        }
      } catch (e) {
        console.error('ALERT analyst-llm-failed', { status: (e as { status?: number }).status });
      }
    }

    // Email the digest (SMTP reuse, plain text only).
    try {
      const port = Number(SMTP_PORT.value()) || 465;
      const secure = port === 465;
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST.value(),
        port,
        secure,
        requireTLS: !secure,
        auth: { user: SMTP_USER.value(), pass: SMTP_PASSWORD.value() },
      });
      await transporter.sendMail({
        from: { name: 'Island Analyst', address: LEAD_FROM.value() },
        to: ANALYST_TO.value() || LEAD_TO.value(),
        subject: headerSafe(`Island daily report — ${day}`, 150),
        text: digest,
      });
    } catch (e) {
      console.error('ALERT analyst-email-failed', { msg: (e as Error).message });
    }

    // File the top proposals as GitHub issues (never code edits). Throttled by
    // a cooldown + open-backlog cap so the repo never fills with re-worded dupes.
    const filed = await fileGithubIssues(db, GITHUB_TOKEN.value(), proposals, now);

    // Publish the safe, counts-only public notice for the in-world board.
    const notice = buildNotice(m);
    await db.ref('world/island/notice').set({ day, lines: notice.lines, counts: notice.counts, updatedAt: now });

    // Account tokens.
    if (usedNow) {
      await db.ref(`aiUsage/${month}/tokens`).transaction((c) => (c || 0) + usedNow);
      await db.ref(`aiUsage/${month}/calls`).transaction((c) => (c || 0) + 1);
    }
    console.log(`analyst day=${day} devices=${m.activeDevices} leadsNew=${m.leadsNew} proposals=${proposals.length} filed=${filed} tokens=${usedNow}`);
  },
);
