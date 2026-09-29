export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const BASE_CSS = `
  *{box-sizing:border-box}
  body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;margin:0;color:#1d2330;background:#f7f7f9}
  header.site{background:#243b6b;color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:center}
  header.site .brand{font-weight:700;font-size:18px}
  main{max-width:1100px;margin:24px auto;padding:0 24px}
  .card{background:#fff;border:1px solid #dde1ea;border-radius:8px;padding:20px;margin-bottom:16px}
  button,.btn{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #243b6b;background:#243b6b;color:#fff;cursor:pointer}
  button.secondary{background:#fff;color:#243b6b}
  input,select,textarea{font:inherit;padding:6px 8px;border:1px solid #b8bfcc;border-radius:4px}
  label{display:block;margin:10px 0 4px;font-weight:600}
  .muted{color:#667085}
  .result{margin-top:12px;padding:12px;background:#eef6ee;border:1px solid #9cc79c;border-radius:6px}
  table{border-collapse:collapse;width:100%}
  th,td{border-bottom:1px solid #e3e6ee;padding:8px;text-align:left}
`;

// Every fixture page loads the beacon, which reports the real viewport and page views
// to the server so the checker never relies on the agent's own report of what it saw.
export function page({ title, body, head = '', script = '', css = '', bare = false }) {
  const shell = bare
    ? body
    : `<header class="site"><span class="brand">Acme Outdoor</span><span class="muted" style="color:#c9d3ea">Test site</span></header><main>${body}</main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}${css}</style>
<script src="/__bench/b.js"></script>
${head}
</head>
<body>
${shell}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

export const BEACON_JS = `(() => {
  const send = (type, data) => {
    try {
      fetch('/__bench/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, data, url: location.href }),
        keepalive: true,
      });
    } catch (error) {}
  };
  window.__bench = send;
  const viewport = () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, top: window === top });
  send('pageview', { ...viewport(), ua: navigator.userAgent, title: document.title });
  let timer;
  addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => send('resize', viewport()), 250);
  });
})();`;
