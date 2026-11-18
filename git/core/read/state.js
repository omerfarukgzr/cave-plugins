// State group: repo.state, repo.refresh, repo.subscribe, repo.unsubscribe.
export default [
  {
    name: 'repo.state', repo: true, mutating: false, params: {},
    handler: (ctx) => ctx.snapshot(),
  },
  {
    name: 'repo.refresh', repo: true, mutating: false, params: {},
    handler: (ctx) => ctx.refresh(),
  },
  {
    name: 'repo.subscribe', repo: true, mutating: false, params: {},
    async handler(ctx) {
      ctx.subscribe();
      const snap = await ctx.snapshot();
      return { root: ctx.repo.root, version: snap.version };
    },
  },
  {
    name: 'repo.unsubscribe', repo: true, mutating: false, params: {},
    async handler(ctx) {
      ctx.unsubscribe();
      return { root: ctx.repo.root };
    },
  },
];
