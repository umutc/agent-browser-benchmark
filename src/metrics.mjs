// Turns one `claude -p --output-format stream-json --verbose` transcript into run metrics.
// `arrivals[i]` is the wall-clock time the runner received line i, which gives tool
// latency even when the run was killed before a result event.
export function parseStream(lines, arrivals) {
  const events = [];
  lines.forEach((line, index) => {
    try {
      events.push({ event: JSON.parse(line), at: arrivals[index] });
    } catch {}
  });

  const result = events.map((e) => e.event).findLast((e) => e.type === 'result') ?? null;
  const init = events.map((e) => e.event).find((e) => e.type === 'system' && e.subtype === 'init') ?? null;

  const toolUseAt = new Map();
  const toolNames = {};
  const messageUsage = new Map();
  let toolCalls = 0;
  let toolTimeMs = 0;
  let toolResultBytes = 0;
  let toolResultImages = 0;
  let toolErrors = 0;
  const rateLimits = [];
  const toolResultTexts = [];

  for (const { event, at } of events) {
    if (event.type === 'rate_limit_event') rateLimits.push(event.rate_limit_info);
    if (event.type === 'assistant') {
      const message = event.message || {};
      if (message.id && message.usage) messageUsage.set(message.id, message.usage);
      for (const block of message.content || []) {
        if (block.type !== 'tool_use') continue;
        toolCalls += 1;
        toolNames[block.name] = (toolNames[block.name] || 0) + 1;
        toolUseAt.set(block.id, at);
      }
    }
    if (event.type === 'user') {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        if (block.is_error) toolErrors += 1;
        const started = toolUseAt.get(block.tool_use_id);
        if (started) toolTimeMs += at - started;
        const parts = Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content ?? '') }];
        for (const part of parts) {
          if (part.type === 'image') toolResultImages += 1;
          else {
            const text = part.text ?? JSON.stringify(part);
            toolResultBytes += Buffer.byteLength(text);
            toolResultTexts.push(text);
          }
        }
      }
    }
  }

  const summed = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
  for (const usage of messageUsage.values()) {
    summed.input += usage.input_tokens || 0;
    summed.cacheCreate += usage.cache_creation_input_tokens || 0;
    summed.cacheRead += usage.cache_read_input_tokens || 0;
    summed.output += usage.output_tokens || 0;
  }
  const finalUsage = result?.usage
    ? {
        input: result.usage.input_tokens || 0,
        cacheCreate: result.usage.cache_creation_input_tokens || 0,
        cacheRead: result.usage.cache_read_input_tokens || 0,
        output: result.usage.output_tokens || 0,
      }
    : summed;

  const firstAt = arrivals[0];
  const lastAt = arrivals.at(-1);
  return {
    hasResult: Boolean(result),
    isError: result?.is_error ?? null,
    subtype: result?.subtype ?? null,
    resultText: typeof result?.result === 'string' ? result.result.slice(0, 2000) : null,
    structured: result?.structured_output ?? null,
    durationMs: result?.duration_ms ?? (lastAt && firstAt ? lastAt - firstAt : null),
    durationApiMs: result?.duration_api_ms ?? null,
    numTurns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    usage: finalUsage,
    totalInputTokens: finalUsage.input + finalUsage.cacheCreate + finalUsage.cacheRead,
    permissionDenials: result?.permission_denials?.length ?? 0,
    deniedCommands: (result?.permission_denials || []).map((d) => JSON.stringify(d.tool_input).slice(0, 200)),
    toolCalls,
    toolNames,
    toolTimeMs,
    toolErrors,
    toolResultBytes,
    toolResultImages,
    initTools: init?.tools ?? [],
    mcpServers: init?.mcp_servers ?? [],
    model: init?.model ?? null,
    rateLimit: rateLimits.at(-1) ?? null,
    toolResultTexts,
  };
}

export function isRateLimited(metrics, stderr) {
  if (metrics.rateLimit?.status === 'rejected') return true;
  const text = `${metrics.resultText || ''}\n${stderr || ''}`;
  if (metrics.isError || !metrics.hasResult) return /usage limit|rate limit|rate_limit|overloaded|529|capacity/i.test(text);
  return false;
}
