// Diagnostics group: diag.report — a page's error for the engine's log on disk (core/disklog.js, docs/PROTOCOL.md).
// The pages send uncaught errors, unhandled rejections, the error notices they show and host events (ui/git/diag.js);
// the engine writes them as { kind: 'page', … } lines, rate limited (createReportLimit). Without a log it writes nothing.
import { redactText } from '../redact.js';

const clip = (s, n) => (typeof s === 'string' ? redactText(s).slice(0, n) : undefined);

export default [
  {
    name: 'diag.report', repo: false, mutating: false,
    params: {
      kind: { type: 'enum', values: ['error', 'rejection', 'notice', 'host'] },
      message: { type: 'string', maxLength: 4000 },
      title: { type: 'string', optional: true, maxLength: 1000 },
      source: { type: 'string', optional: true, maxLength: 1000 },
      line: { type: 'int', optional: true, min: 0, max: 100000000 },
      column: { type: 'int', optional: true, min: 0, max: 100000000 },
      stack: { type: 'string', optional: true, maxLength: 8000 },
      view: { type: 'string', optional: true, maxLength: 40 },
      root: { type: 'string', optional: true, maxLength: 4096 },
    },
    async handler(ctx, p) {
      const line = { kind: 'page', what: p.kind, message: clip(p.message, 500) };
      if (p.title) line.title = clip(p.title, 200);
      if (p.source) line.source = clip(p.source, 300);
      if (p.line !== undefined) line.line = p.line;
      if (p.column !== undefined) line.column = p.column;
      if (p.stack) line.stack = clip(p.stack, 2000).split('\n').slice(0, 12);
      if (p.view) line.view = clip(p.view, 40);
      if (p.root) line.repo = clip(p.root, 4096);
      return { logged: ctx.report(line) };
    },
  },
];
