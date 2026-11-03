// Behavioural check of database.rules.json against the Realtime Database
// emulator. Every case is a write or read the client really makes (or a
// hostile variant of one), so a rules change that would reject live traffic
// fails here before it is deployed.
//
// Needs Java 11+ and firebase-tools. From the repo root:
//   firebase emulators:exec --only database --project demo-life-island "node tools/rules-check.mjs"
// The demo- project id keeps the run fully offline.
import { initializeApp } from 'firebase/app';
import {
  connectDatabaseEmulator,
  get,
  getDatabase,
  push,
  ref,
  remove,
  set,
  update,
} from 'firebase/database';

const [HOST, PORT] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000').split(':');
const NS = 'demo-life-island-default-rtdb';
const now = Date.now();

const dbs = new Map();
/** A client signed in as `uid` (anonymous auth in production). */
function as(uid) {
  if (!dbs.has(uid)) {
    const app = initializeApp(
      { projectId: 'demo-life-island', databaseURL: `https://${NS}.firebaseio.com` },
      `rules-check-${uid}`,
    );
    const db = getDatabase(app);
    connectDatabaseEmulator(db, HOST, Number(PORT), { mockUserToken: { sub: uid, user_id: uid } });
    dbs.set(uid, db);
  }
  return dbs.get(uid);
}

/** Seed data as an admin, bypassing the rules (the emulator's owner token). */
async function seed(path, value) {
  const res = await fetch(`http://${HOST}:${PORT}/${path}.json?ns=${NS}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`seed ${path}: ${res.status}`);
}

const results = [];
async function expectOutcome(label, want, op) {
  let got;
  let detail = '';
  try {
    await op();
    got = 'allow';
  } catch (e) {
    got = /permission[_ ]denied/i.test(String(e?.code ?? e?.message)) ? 'deny' : 'error';
    detail = got === 'error' ? ` (${String(e?.message ?? e).slice(0, 120)})` : '';
  }
  results.push({ label, want, got, ok: got === want });
  console.log(
    `${got === want ? 'PASS' : 'FAIL'}  ${want.padEnd(5)} ${label}${got === want ? '' : ` -> ${got}${detail}`}`,
  );
}
const allow = (label, op) => expectOutcome(label, 'allow', op);
const deny = (label, op) => expectOutcome(label, 'deny', op);

const u1 = as('u1');
const u2 = as('u2');

// --- presence: the 10 Hz hot node (Multiplayer.ts send 'state') -------------
const onFoot = {
  p: [1.5, 2, -3],
  q: [0, 0, 0, 1],
  veh: null,
  vehIdx: -1,
  vp: null,
  vq: null,
  t: now,
  wave: 0,
  pose: 0,
};
await allow('presence: on foot, as Multiplayer writes it', () =>
  set(ref(u1, 'presence/island/u1'), onFoot),
);
await allow('presence: riding a vehicle', () =>
  set(ref(u1, 'presence/island/u1'), {
    ...onFoot,
    veh: 'boat',
    vehIdx: 2,
    vp: [4, 5, 6],
    vq: [0, 1, 0, 0],
    pose: 2,
  }),
);
await allow('presence: an old client still sending name, hat and cols', () =>
  set(ref(u1, 'presence/island/u1'), {
    ...onFoot,
    name: 'Sam',
    hat: 'party',
    founder: false,
    cols: { outfit: 1, skin: 2 },
  }),
);
await deny('presence: p with a 4th element', () =>
  set(ref(u1, 'presence/island/u1'), { ...onFoot, p: [1, 2, 3, 4] }),
);
await deny('presence: p missing an element', () =>
  set(ref(u1, 'presence/island/u1'), { ...onFoot, p: [1, 2] }),
);
await deny('presence: p as a number', () =>
  set(ref(u1, 'presence/island/u1'), { ...onFoot, p: 7 }),
);
await deny('presence: q with a 5th element', () =>
  set(ref(u1, 'presence/island/u1'), { ...onFoot, q: [0, 0, 0, 1, 9] }),
);
await deny('presence: vp with extra elements', () =>
  set(ref(u1, 'presence/island/u1'), {
    ...onFoot,
    veh: 'boat',
    vehIdx: 1,
    vp: [1, 2, 3, 4, 5],
    vq: [0, 0, 0, 1],
  }),
);
await deny('presence: cols with an unknown part', () =>
  set(ref(u1, 'presence/island/u1'), { ...onFoot, cols: { outfit: 1, junk: 2 } }),
);
await deny('presence: an unknown field', () =>
  set(ref(u1, 'presence/island/u1'), { ...onFoot, junk: 'x' }),
);
await deny("presence: writing another visitor's node", () =>
  set(ref(u2, 'presence/island/u1'), onFoot),
);

// --- meta: the cold node (Multiplayer.ts writeMeta) -------------------------
await allow('meta: name, hat, founder and colours', () =>
  set(ref(u1, 'meta/island/u1'), {
    name: 'Sam',
    hat: 'crown',
    founder: false,
    cols: { outfit: 1, pants: 2, hair: 3, skin: 4 },
    t: now,
  }),
);
await allow('meta: name only (hat and cols null)', () =>
  set(ref(u1, 'meta/island/u1'), { name: 'Sam', hat: null, founder: false, cols: null, t: now }),
);
await deny('meta: cols with an unknown part', () =>
  set(ref(u1, 'meta/island/u1'), {
    name: 'Sam',
    founder: false,
    cols: { outfit: 1, wings: 2 },
    t: now,
  }),
);

// --- profiles: saveProfile's update() patches (profileSync.ts) --------------
const fullSave = {
  name: 'Sam',
  hat: 'crown',
  ownedHats: ['party', 'top', 'crown'],
  coins: 12,
  birdFeed: 1,
  catFeed: 0,
  fishFeed: 2,
  colors: { outfit: '#a1b2c3', pants: '#000000', hair: '#ffffff', skin: '#c68642' },
  lastSeen: now,
  t: now,
};
await allow('profiles: the session-end save (main-simple)', () =>
  update(ref(u1, 'profiles/u1'), fullSave),
);
await allow('profiles: lessons', () =>
  update(ref(u1, 'profiles/u1'), {
    lessons: ['move', 'fish', 'chop', 'feed', 'chat', 'build'],
    t: now,
  }),
);
await allow('profiles: tools', () =>
  update(ref(u1, 'profiles/u1'), { tools: ['rod', 'axe', 'sickle', 'pickaxe'], t: now }),
);
await allow('profiles: meals', () =>
  update(ref(u1, 'profiles/u1'), { meals: { pie: 1, fish: 0, soup: 2 }, t: now }),
);
await allow('profiles: inventory', () =>
  update(ref(u1, 'profiles/u1'), {
    inventory: { fish: 3, timber: 4, wheat: 0, produce: 1, ore: 2 },
    t: now,
  }),
);
await allow('profiles: unequipping the hat (null deletes it)', () =>
  update(ref(u1, 'profiles/u1'), { hat: null, t: now }),
);
await allow('profiles: an unknown legacy child already stored does not block saves', async () => {
  await seed('profiles/u1/legacyField', 'old');
  await update(ref(u1, 'profiles/u1'), { coins: 5, t: now });
});
await deny('profiles: an unknown field', () =>
  update(ref(u1, 'profiles/u1'), { junk: 'x', t: now }),
);
await deny('profiles: 101 lessons', () =>
  update(ref(u1, 'profiles/u1'), {
    lessons: Array.from({ length: 101 }, (_, i) => `l${i}`),
    t: now,
  }),
);
await deny('profiles: an over-long lesson id', () =>
  update(ref(u1, 'profiles/u1'), { lessons: ['x'.repeat(33)], t: now }),
);
await deny('profiles: colours for an unknown part', () =>
  update(ref(u1, 'profiles/u1'), { colors: { wings: '#ffffff' }, t: now }),
);
await deny('profiles: an over-long colour value', () =>
  update(ref(u1, 'profiles/u1'), { colors: { outfit: '#'.padEnd(200, 'f') }, t: now }),
);
await deny('profiles: an unknown meal', () =>
  update(ref(u1, 'profiles/u1'), { meals: { pie: 1, cake: 2 }, t: now }),
);
await deny('profiles: an unknown inventory item', () =>
  update(ref(u1, 'profiles/u1'), { inventory: { fish: 1, gold: 9 }, t: now }),
);
await deny("profiles: writing another visitor's profile", () =>
  update(ref(u2, 'profiles/u1'), { coins: 1, t: now }),
);
await deny("profiles: reading another visitor's profile", () => get(ref(u2, 'profiles/u1')));

// --- leaderboard: Boards.submitRaceTime and getLeaderboard ------------------
const lap = { name: 'Sam', timeMs: 61234, t: now };
await allow('leaderboard: a land time at the era path Boards.ts writes', () =>
  set(ref(u1, 'leaderboard/island/r100/land/u1'), lap),
);
await allow('leaderboard: a water time', () =>
  set(ref(u1, 'leaderboard/island/r100/water/u1'), lap),
);
await allow('leaderboard: any signed-in visitor reads a circuit', () =>
  get(ref(u2, 'leaderboard/island/r100/land')),
);
await deny("leaderboard: posting another visitor's time", () =>
  set(ref(u1, 'leaderboard/island/r100/land/u2'), lap),
);
await deny('leaderboard: an unknown circuit', () =>
  set(ref(u1, 'leaderboard/island/r100/air/u1'), lap),
);
await deny('leaderboard: a malformed era', () =>
  set(ref(u1, 'leaderboard/island/era1/land/u1'), lap),
);
await deny('leaderboard: the old era-less path', () =>
  set(ref(u1, 'leaderboard/island/land/u1'), lap),
);
await deny('leaderboard: an extra field', () =>
  set(ref(u1, 'leaderboard/island/r100/land/u1'), { ...lap, junk: 1 }),
);

// --- world/benches: worldBenches.placeBench ---------------------------------
await allow('benches: placing a bench in a free slot', () =>
  set(ref(u1, 'world/benches/u1_0'), { plot: 3, t: now }),
);
await deny('benches: an extra child', () =>
  set(ref(u1, 'world/benches/u1_1'), { plot: 3, t: now, junk: 'x'.repeat(1000) }),
);
await deny('benches: rewriting a placed bench', () =>
  set(ref(u1, 'world/benches/u1_0'), { plot: 4, t: now }),
);
await deny("benches: a slot in another visitor's name", () =>
  set(ref(u1, 'world/benches/u2_0'), { plot: 3, t: now }),
);
await deny('benches: a fifth slot', () => set(ref(u1, 'world/benches/u1_4'), { plot: 3, t: now }));

// --- unchanged nodes, as a regression net -----------------------------------
await allow('builds: raising a build', () =>
  set(ref(u1, 'world/builds/u1_0'), { plot: 1, t: now, kind: 2 }),
);
await allow('builds: demolishing it', () => remove(ref(u1, 'world/builds/u1_0')));
await allow('chat: a message', () =>
  set(push(ref(u1, 'chat/island')), { id: 'u1', text: 'hi', audio: null, dur: null, t: now }),
);
await allow('guestbook: signing it', () =>
  set(push(ref(u1, 'guestbook/island')), { id: 'u1', name: 'Sam', msg: 'hello', t: now }),
);
await deny('world/island: a client write', () => set(ref(u1, 'world/island/headline'), 'hi'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} cases behave as expected`);
process.exit(failed.length ? 1 : 0);
