// Per-repository queue for mutating methods and the job/progress plumbing (docs/ARCHITECTURE.md §3.2).
//
// Queue: run(key, fn) chains fn after everything already queued for `key` (the repository's common dir, so linked
// worktrees of one repository share one queue). A request made while another runs waits; it does not fail.
//
// Jobs: start({ repo, title, cancellable }) -> job
//   job.id           number, unique per engine
//   job.signal       AbortSignal, aborted by job.cancel; pass it to ctx.git(…, { signal })
//   job.progress(text, fraction?)  publishes `progress { repo, job, title, text, fraction }`
//   job.cancellable(bool)          IntelliJ only lets you cancel the network phase; flip it off after that phase
//   job.end(state)                 'done' | 'failed' | 'cancelled' — the engine calls it when the handler returns
// Every change of state publishes `job { repo, job, title, state, cancellable }`.

export function createQueue() {
  const tails = new Map();
  const depth = new Map();
  return {
    run(key, fn) {
      const prev = tails.get(key) || Promise.resolve();
      depth.set(key, (depth.get(key) || 0) + 1);
      const next = prev.catch(() => {}).then(fn);
      const tail = next.catch(() => {}).finally(() => {
        const d = depth.get(key) - 1;
        if (d) depth.set(key, d); else depth.delete(key);
        if (tails.get(key) === tail) tails.delete(key);
      });
      tails.set(key, tail);
      return next;
    },
    /** Number of queued or running mutating requests for `key`. */
    pending(key) { return depth.get(key) || 0; },
    /** Keys with something queued or running (diagnostics). */
    size: () => tails.size,
  };
}

export function createJobs(emit) {
  let seq = 0;
  const live = new Map();

  function start({ repo, title, cancellable = false }) {
    const id = ++seq;
    const ctl = new AbortController();
    let canCancel = cancellable;
    let ended = false;
    const publish = (state) => emit('job', { repo, job: id, title, state, cancellable: canCancel });
    const job = {
      id,
      title,
      signal: ctl.signal,
      progress(text, fraction) {
        if (ended) return;
        emit('progress', { repo, job: id, title, text: text == null ? '' : String(text), fraction: typeof fraction === 'number' ? Math.max(0, Math.min(1, fraction)) : null });
      },
      cancellable(on) { canCancel = !!on; publish('running'); },
      isCancellable: () => canCancel,
      cancel() { if (!canCancel || ended) return false; ctl.abort(); return true; },
      end(state) {
        if (ended) return;
        ended = true;
        live.delete(id);
        publish(state);
      },
    };
    live.set(id, job);
    publish('running');
    return job;
  }

  return {
    start,
    get: (id) => live.get(id) || null,
    cancel(id) { const j = live.get(id); return j ? j.cancel() : false; },
    list: () => Array.from(live.values()).map((j) => ({ id: j.id, title: j.title, cancellable: j.isCancellable() })),
  };
}
