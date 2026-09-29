import { createHmac, randomBytes } from 'node:crypto';

// Generated at process start and never written to disk, so an agent that reads the
// repo cannot derive the expected answers.
const SECRET = randomBytes(32);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function code(runId, key, length = 6) {
  const digest = createHmac('sha256', SECRET).update(`${runId}:${key}`).digest();
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[digest[i] % ALPHABET.length];
  return out;
}

export function digits(runId, key, length = 6) {
  const digest = createHmac('sha256', SECRET).update(`${runId}:digits:${key}`).digest();
  let out = '';
  for (let i = 0; i < length; i++) out += String(digest[i] % 10);
  return out;
}

// Deterministic PRNG per run and key, for seeded data sets and bug placement.
export function rng(runId, key) {
  const digest = createHmac('sha256', SECRET).update(`${runId}:rng:${key}`).digest();
  let state = digest.readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

export function shuffle(random, list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function newRunId() {
  return randomBytes(5).toString('hex');
}
