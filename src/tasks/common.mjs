export const TIMEOUTS = { k0: 120, k1: 240, k2: 540, k3: 540 };

export function defineTask(definition) {
  const tier = definition.tier;
  return {
    timeoutSec: TIMEOUTS[tier],
    routes: {},
    start: '/',
    ...definition,
    schema: buildSchema(definition.answer || {}),
  };
}

function buildSchema(answer) {
  return {
    type: 'object',
    properties: {
      completed: { type: 'boolean', description: 'true if you believe you completed the task' },
      notes: { type: 'string', description: 'short notes, including anything that blocked you' },
      ...answer,
    },
    required: ['completed', 'notes', ...Object.keys(answer)],
    additionalProperties: false,
  };
}

export function buildPrompt(task, context, env) {
  if (task.tier === 'k0') return task.prompt(context, env);
  const start = context.url(task.start);
  return [
    'You are operating a web browser through the tools available to you.',
    'The web page is a local test site. Use the browser to interact with it.',
    '',
    `Start at: ${start}`,
    '',
    `Task: ${task.prompt(context, env)}`,
    '',
    'When you are done, give the final answer in the required structured format.',
    'If you could not complete the task, set completed to false and explain briefly in notes.',
  ].join('\n');
}

export const str = (description) => ({ type: 'string', description });
export const num = (description) => ({ type: 'number', description });

export function norm(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/^["'`]|["'`]$/g, '');
}

export const serverEvents = (events, type) => events.filter((e) => e.source === 'server' && e.type === type);
export const clientEvents = (events, type) => events.filter((e) => e.source === 'client' && e.type === type);

// True when the page saw at least one trusted (real user input) event of that type,
// false when only synthetic events arrived, null when the page logged nothing.
export function trustedInput(events, type) {
  const matches = clientEvents(events, type);
  if (matches.length === 0) return null;
  return matches.some((e) => e.data?.trusted === true);
}

export function result(pass, details = {}, extra = {}) {
  return { pass: Boolean(pass), details, ...extra };
}
