/* The UI's neutral name for itself: the one place in ui/ that names the product family. A host never edits this file;
   it hands its own values through Git.host before the UI starts (the standalone server's host/adapter.js, a host's
   panel script). What a host may set:
     Git.host.product        the name in messages ("Cannot reach the {0} server"); default PRODUCT.name
     Git.host.storagePrefix  the prefix of every key the UI keeps in localStorage; default PRODUCT.storagePrefix
     Git.host.skinLabel      the label of the default skin in the Appearance menu; default "Default"
     Git.host.skinAliases    stored or ?skin= values read as another skin, e.g. { old: 'default' }
     Git.host.startCommand   the command that starts the server, named on the "cannot reach" page (none: not named)
     Git.host.unreachableHint  a function returning the (translated) advice for that page when a host runs the server
                             itself; it takes the place of the start command's line
   Loaded first in ui/index.html; read only when the UI runs, so a host script loaded before it may use it too. */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  // command: the standalone server's CLI (bin/git-panel), named by host/standalone.js
  Git.PRODUCT = Object.freeze({ name: 'Git Panel', storagePrefix: 'git-panel:', command: 'git-panel' });
  /** The product name the user sees in messages: the host's, else the neutral one. */
  Git.product = () => (Git.host && Git.host.product) || Git.PRODUCT.name;
  /** The prefix of the UI's localStorage keys: the host's, else the neutral one. */
  Git.storagePrefix = () => (Git.host && Git.host.storagePrefix) || Git.PRODUCT.storagePrefix;
})();
