/**
 * The Bank vault — the ONLY shared money in the game (economy spec, Decision 1).
 *
 * Coins are client-authoritative and per-device (adopt-once, Phase 0). The
 * vault is the deliberate exception: a server-validated balance under
 * `bank/{uid}` that survives devices, mutated ONLY here (clients have no
 * write access — see database.rules.json). Deposits are soft-trust by design
 * (the client asserts it removed local coins; a forged deposit only inflates
 * the forger's own vault). Withdrawals are the guarded edge: the transaction
 * refuses to go below zero, so vault money can be duplicated by NOBODY —
 * not even a dishonest client — only invented at deposit time, which is
 * exactly the trust line the design draws.
 *
 * Idempotency: every op carries a client-minted key. A replay (double-tap,
 * offline queue flush, reload mid-request) finds the key in `ops` and returns
 * the current balance with applied:false — never a second mutation. Keys are
 * pruned oldest-first past 50 to bound the node.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

const MAX_OP = 500; // per-op coin ceiling — bounds forged-deposit inflation
const MAX_BALANCE = 100000;
const OPS_KEPT = 50;

interface VaultNode {
  balance?: number;
  ops?: Record<string, number>; // key -> server ms, for pruning
}

export const vaultOp = onCall(
  { region: 'us-central1', enforceAppCheck: false },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'sign-in required');
    const op = req.data?.op as string;
    const amountRaw = req.data?.amount;
    const key = req.data?.key as string;
    if (op !== 'deposit' && op !== 'withdraw' && op !== 'balance') {
      throw new HttpsError('invalid-argument', 'bad op');
    }
    const ref = admin.database().ref(`bank/${uid}`);
    if (op === 'balance') {
      const snap = await ref.child('balance').get();
      return { balance: Math.max(0, Number(snap.val()) || 0), applied: false };
    }
    const amount = Math.floor(Number(amountRaw));
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_OP || typeof key !== 'string' || key.length < 8 || key.length > 64) {
      throw new HttpsError('invalid-argument', 'bad amount/key');
    }
    let applied = false;
    const result = await ref.transaction((cur: VaultNode | null) => {
      const node: VaultNode = cur ?? {};
      const ops = node.ops ?? {};
      const balance = Math.max(0, Number(node.balance) || 0);
      applied = false;
      if (ops[key] !== undefined) return node; // replay — no-op, keep as-is
      let next = balance;
      if (op === 'deposit') next = Math.min(MAX_BALANCE, balance + amount);
      else {
        if (balance < amount) return node; // insufficient — unchanged, applied stays false
        next = balance - amount;
      }
      ops[key] = Date.now();
      const keys = Object.keys(ops);
      if (keys.length > OPS_KEPT) {
        keys.sort((a, b) => ops[a] - ops[b]);
        for (const k of keys.slice(0, keys.length - OPS_KEPT)) delete ops[k];
      }
      applied = true;
      return { balance: next, ops };
    });
    const node = (result.snapshot.val() as VaultNode | null) ?? {};
    return { balance: Math.max(0, Number(node.balance) || 0), applied };
  },
);
