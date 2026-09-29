import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { page } from '../../lib/html.mjs';
import { defineTask, str, norm, serverEvents, result } from '../common.mjs';

const uploadPath = (c, env) => join(env.workdir, `bench-upload-${c.runId}.txt`);

const upload = defineTask({
  id: 'k1-upload',
  tier: 'k1',
  capability: 'file upload',
  title: 'File upload',
  answer: { receipt: str('the receipt code shown after uploading') },
  prepare: (c, env) => writeFileSync(uploadPath(c, env), `Expense report\nupload-token: ${c.code('u')}\n`),
  prompt: (c, env) =>
    `Upload the file at ${uploadPath(c, env)} using the upload form, then report the receipt code shown after the upload.`,
  routes: {
    'GET /': () =>
      page({
        title: 'Expenses',
        body: `<div class="card"><h1>Submit an expense report</h1>
          <form method="post" action="upload" enctype="multipart/form-data">
            <label for="file">Report file</label><input id="file" type="file" name="file">
            <div style="margin-top:12px"><button type="submit">Upload</button></div>
          </form></div>`,
      }),
    'POST /upload': (c, req) => {
      const text = req.body.toString('latin1');
      const token = text.match(/upload-token: ([A-Z0-9]+)/)?.[1] ?? null;
      c.log('upload', { token, bytes: req.body.length });
      const ok = token === c.code('u');
      return page({
        title: 'Upload result',
        body: ok
          ? `<div class="card result"><h1>Report received</h1><p>Receipt: <strong>${c.code('r')}</strong></p></div>`
          : '<div class="card"><h1>File not recognised</h1><a href="./">Try again</a></div>',
      });
    },
  },
  check: (c, out, events) => {
    const uploaded = serverEvents(events, 'upload').some((e) => e.data.token === c.code('u'));
    return result(uploaded && norm(out?.receipt) === c.code('r'), { uploaded, got: out?.receipt });
  },
});

const download = defineTask({
  id: 'k1-download',
  tier: 'k1',
  capability: 'file download',
  title: 'File download',
  answer: { code: str('the code written inside the downloaded file') },
  prompt: () => 'Download the report using the "Download report" link and report the code written inside the downloaded file.',
  routes: {
    'GET /': () =>
      page({
        title: 'Reports',
        body: `<div class="card"><h1>Quarterly report</h1><p>The report is available as a text file.</p>
          <a class="btn" href="report.txt">Download report</a></div>`,
      }),
    'GET /report.txt': (c) => {
      c.log('download');
      return {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="bench-report-${c.runId}.txt"`,
        },
        body: `Quarterly report\nreport-code: ${c.code('d')}\n`,
      };
    },
  },
  check: (c, out, events) =>
    result(norm(out?.code) === c.code('d'), { got: out?.code, downloadRequests: serverEvents(events, 'download').length }),
});

const cookie = defineTask({
  id: 'k1-cookie',
  tier: 'k1',
  capability: 'HttpOnly cookie',
  title: 'Read an HttpOnly cookie',
  answer: { value: str('the value of the bench_session cookie') },
  prompt: () => 'This site stores a session value in an HttpOnly cookie named "bench_session". Report the value of that cookie.',
  routes: {
    'GET /': (c) => ({
      headers: { 'set-cookie': `bench_session=${c.code('k', 8)}; HttpOnly; Path=/; SameSite=Lax` },
      body: page({
        title: 'Guest session',
        body: `<div class="card"><h1>Welcome, guest</h1><p>Your session is kept in a secure cookie.</p></div>`,
      }),
    }),
  },
  check: (c, out) => result(norm(out?.value) === c.code('k', 8), { got: out?.value }),
});

export default [upload, download, cookie];
