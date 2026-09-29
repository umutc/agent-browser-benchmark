import { defineTask, result } from '../common.mjs';

// Measures the fixed context cost of each variant: the same trivial answer with no tool
// use, so any token difference between variants comes from tool definitions and the
// variant's system prompt additions.
export default [
  defineTask({
    id: 'k0-baseline',
    tier: 'k0',
    capability: 'baseline',
    title: 'Fixed context cost',
    prompt: () =>
      'Do not use any tools. Reply immediately with completed set to true and notes set to "baseline".',
    check: (c, out) => result(out?.completed === true && /baseline/i.test(out?.notes || '')),
  }),
];
