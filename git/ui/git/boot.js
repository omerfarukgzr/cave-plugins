/* Start. Loaded last: every view module has registered itself by now. */
(function () {
  'use strict';
  const Git = window.Git;
  Git.store.wire();
  const start = () => Git.workbench.boot();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
