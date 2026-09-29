import baseline from './k0/baseline.mjs';
import interaction from './k1/interaction.mjs';
import structure from './k1/structure.mjs';
import io from './k1/io.mjs';
import observe from './k1/observe.mjs';

export const TASKS = [...baseline, ...interaction, ...structure, ...io, ...observe];

export function selectTasks(selector) {
  const wanted = selector.split(',').map((s) => s.trim()).filter(Boolean);
  const selected = TASKS.filter((task) => wanted.includes(task.id) || wanted.includes(task.tier) || wanted.includes('all'));
  const unknown = wanted.filter((w) => w !== 'all' && !TASKS.some((t) => t.id === w || t.tier === w));
  if (unknown.length) throw new Error(`unknown task selector: ${unknown.join(', ')}`);
  return selected;
}
