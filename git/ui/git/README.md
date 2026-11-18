# Git Panel UI: the contract

The Git UI of the base: IntelliJ IDEA's Git tool windows on the real engine. It started as the approved clickable
prototype (see the repository's CLAUDE.md for where it lives); its look and behavior stay. The UI never names a host:
what differs per host comes through `Git.host` (`ui/host/product.js` lists the identity fields). This file is binding for everyone who
works in `ui/`. Design: `docs/ARCHITECTURE.md` §6, wire reference: `docs/PROTOCOL.md`.

## 1. Rules (binding)

- **IntelliJ is the spec** for layout, features, labels, icons and status colors (`arastirma/` of the prototype).
- **Two skins**, CSS variables only (`git.css`: `:root` = `default`, `:root[data-git-skin="intellij"]`). Never hard-code a
  color, radius or font; use `var(--g-…)`. The shell parts (menus, editor tab strip, file icons) use
  `../css/tokens.css`. A host may name the default skin (`Git.host.skinLabel`) and map old stored values to it
  (`Git.host.skinAliases`).
- **Label languages.** Code writes IntelliJ's English text through `Git.t('Commit and Push…')`; the Turkish text
  is given with `Git.addTR({ … })` at the top of the module. English is the default, Turkish is available, more can
  be added ("Adding a language" below). Glossary §8.
- **No view keeps repository state.** Everything comes from `Git.repo` (synchronous) or `Git.content` (asynchronous);
  views redraw on `Git.on('change')`. Commands never patch `Git.repo`: the engine publishes `changed` after every
  mutating method and the store follows.
- **Nothing depends on a host's globals** or the shell's CSS. Host differences go through `Git.host`.
- **The Esc rule:** a host that embeds the page may close it on Esc unless a text field has focus. Overlays (menus, popups,
  dialogs) keep an editable element focused (their own field or the focus sink of `ui.js`). Use `Git.menu`,
  `Git.popup`, `Git.dialog` and you get it for free; never put focus on a plain button while an overlay is open.
- Classic `<script>` files, one global `window.Git`, no bundler, no network (vendored files only). New files ≤ 500 lines.

## 2. Files and load order (`ui/index.html`)

| File | What |
|---|---|
| `../host/product.js` | the UI's neutral name (`Git.PRODUCT`, `Git.product()`, `Git.storagePrefix()`) and the list of identity fields a host may set in `Git.host` |
| `../host/adapter.js` | the host adapter: empty here; the server answers this path with a host's own file (`server/identity.js`) |
| `../host/standalone.js` | `Git.backend` (fetch `/rpc`, `EventSource /events`, reconnect + resync), `Git.host` defaults |
| `lang.js` | the label languages: `Git.t`, `Git.addTR`, `Git.addLang`, `Git.languages`, `Git.setLang`, `Git.languageMenu` ("Adding a language" in §8) |
| `store.js` | events, `Git.repo`, loading and resync, the synchronous queries (§3) |
| `content.js` | `Git.content`: async reads with cache and stale-answer protection (§4) |
| `ui.js`, `ui-tree.js`, `vlist.js`, `menu.js`, `fileicons.js`, `look.js` | shared components (§7; `Git.tree` lives in `ui-tree.js`), virtual list, the pop-up menu (`Git.popupMenu`), the file icons (the host's theme, else Seti), the host's fonts (§6) |
| `diffcore.js`, `graph-ref.js`, `graph.js`, `graphpaint.js`, `icons.js` | diff, commit graph, IntelliJ icons |
| `actions.js` + `actions-changes.js`, `actions-history.js`, `actions-branches.js` | the command core (§5) and the commands per area |
| `workbench.js`, `picker.js`, `workbench.css` | page layout, tabs, single-view mode, repository picker (§6) |
| `worktrees.js` | the Worktrees chip, its list and the strip while another worktree is shown; the page's home and the kept pick (§6 "Worktrees") |
| `update.js` | updates of the product itself, with a host that has releases (`Git.host.update = { steps(), check(), checkNow(), run() }`): "Check for Updates…" always stands in the Options menu (reads the channel now: a newer release opens its dialog, else a short answer); a newer release is a dot on the Options button and a row "Update to …" in its menu (a dialog with the note, the way by hand and Update Now); below the host's minimum the dot is in the warning color and the dialog opens by itself, once a day (`product.update.reminded` in the host's preferences). Nothing is ever locked (the owner, 17 Nov 2026): "Later" closes the dialog and the page works as before. `unknown` (the host could not tell) shows nothing. `Git.update.apply(info)`, `.refresh()`, `.remind()`, `.rows()`, `.checkNow()`, `.open()`, `.mark(button)`, `.reload()` |
| `centre.js` | centre presence: whether a diff shows in the centre (this page's editor area or a host's centre page), the preview rule (docs/ARCHITECTURE.md §6.2) |
| `console.js` | Console tab |
| `log-logic.js`, `log-view.js`, `log-labels.js`, `log-filters.js`, `log-layout.js`, `log-place.js`, `log-menu.js`, `log.js`, `log-details.js`, `log-dialogs.js`, `log-branches.js` | the Log (§13): DOM-free rules, shown commits, ref labels, toolbar, the three arrangements and the Branches drawer (§13.3), the place remembered across a re-created page, commit menu, table, Changed Files + Details, dialogs, Branches pane |
| `log-tabs-common.js`, `log-history.js`, `log-compare.js` | History: <file>, Compare with Current, Changes Between <branch> and Current Working Tree (§13) |
| `log-preview.js`, `log-revisions.js`, `log-actions.js` | the diff preview (File History, Log), Show Repository at Revision / Compare Versions / Paths Affected, the commit menu's dialog commands (§13.1) |
| `changes-model.js` | DOM-free logic of the working tree views (§11): message history, Group By Directory, one diff block applied, the Files index, `textHash` |
| `commit-message.js`, `commit-dialogs.js`, `commit.js`, `commit-drag.js` | Commit view (§11): message/Amend/history/checks, Rollback Changes + Delete dialogs, the tree, drag and drop between Changes and Unversioned Files |
| `diffview-load.js`, `diffview.js`, `diffview-parts.js` | diff tabs: what a tab shows + viewer settings, the tab, the model/pane HTML/shapes |
| `fileview.js`, `annotate.js`, `filetree.js` | read-only file view with change markers, Annotate with Git Blame, the Files tool window (§11) |
| `diffview-bar.js` | the diff tab's toolbar, Settings gear, context menus, keys and the "Include into commit" header box (§11) |
| `fileview-marker.js`, `changes-menus.js` | the change marker popup of the file view; the Git ▸ submenu and the menus the Commit view and Files share (§11) |
| `actions-op.js`, `actions-remote.js` | the ongoing operation and its conflicts; Fetch / Update / Push (§12) |
| `actions-stash.js`, `stash-dialogs.js`, `stash-view.js` | Stash (§11.9): the commands, the Stash / Unstash… / Unstash Changes dialogs and the Drop / Clear questions, the Stash tab beside Commit with its header tabs |
| `branches-tree.js`, `branches.js`, `branches-dialogs.js`, `branches-problems.js`, `branches-push.js` | branch widget, Branches popup, the branch dialogs, IntelliJ's "Problem" questions, Push dialog (§12) |
| `merge.js`, `merge-conflicts.js`, `merge-core.js`, `merge-paint.js`, `merge-tool.js`, `merge-plan.js`, `merge-rebase.js` | Merge / Rebase dialogs, Conflicts dialog, the three-pane merge tool (logic, drawing, window), Rebasing Commits (plan, dialog) (§12) |
| `boot.js` | starts the workbench (last) |
| `../css/tokens.css`, `../css/shell.css`, `../img/`, `../vendor/` | the default skin's tokens, menu/tab/file icon CSS (the menu's glyphs are drawn in `menu.js`), Seti font, file icon maps (`vendor/file-icons.js`), highlight.js 11.9.0 |

## 3. Store (`store.js`): `Git.repo` and the synchronous queries

`Git.repo` is one object (never replaced; keep a reference). After `Git.store.open(path)`:

```
root, name, gitDir, commonDir, linked, version
head: { branch, detached, unborn }, headId
branches: { name: { head, upstream, ahead, behind, gone } }, remotes: { 'origin/x': id }, remoteNames, remoteUrls,
remoteName, remoteUrl, tags: { name: id }, favorites: Set, recent: [names], me: '<name> <email>' key, meInfo: { name, email }
local: [{ path, status: 'M'|'A'|'D'|'R'|'?', oldPath? }], localTruncated
op: null | snapshot op (PROTOCOL repo.state: { type, conflicts: [{ path, kind }], yours, theirs, sequencer, rebase })
commits: Map id -> { id, parents, author: key, committer: key, time, commitTime, subject, body: '', changes: [] }
authors: { key: { name, email } }      log: { heads, order: [ids newest first], loaded, complete, truncated }
console: [{ kind: 'cmd'|'out'|'err', time, text }]
```

`body` and `changes` of a list commit are empty: the commit list carries metadata only. Ask `Git.content.details(id)`.

Queries (synchronous, prototype names and meaning): `Git.commit(id)`, `Git.author(key)` → `{ name, email }`,
`Git.isMine(c)`, `Git.short(id)`, `Git.headId()`, `Git.currentBranch()`, `Git.refId(name)`, `Git.isLocal/isRemote(name)`,
`Git.localBranches()`, `Git.remoteBranches()`, `Git.tagNames()`, `Git.upstream(branch)`, `Git.sync(branch)` →
`{ ahead, behind, upstream }` (the engine's counts), `Git.refsAt(id)`, `Git.logHeads(ref?)`, `Git.logOrder(heads?)`
(the engine's order, restricted to what `heads` reach), `Git.closure(id)`, `Git.isAncestor(a, b)`, `Git.range(base, tip)`,
`Git.mergeBase(a, b)`, `Git.children(id)`, `Git.branchesContaining(id)` (walks the graph: prefer
`Git.content.containing`), `Git.isPushed(id)`, `Git.outgoing(branch)` (approximation; `Git.content.outgoing` is the
engine's), `Git.localChanges()`, `Git.unversioned()`, `Git.conflicts()` → `[{ path, kind }]`, `Git.localFile(path)`,
`Git.hasCommits()`. Graph walks are cached per snapshot/refs version.

Gone from the prototype (use the async API): `Git.changeTexts`, `Git.fileAt`, `Git.fileHistory`, every model operation
(`Git.commitFiles`, `Git.checkout`, `Git.merge`, …), `Git.run`, `Git.touch`, `Git.baseText`.

Store API: `Git.store.open(path)` → root (repos.open, subscribe, snapshot and the first 2 000 commits at once; the rest
in one background call) · `.status` `idle|loading|ready|error` · `.resync({ subscribe, refresh })` · `.refresh()`
(repo.refresh; called when the page becomes visible) · `.close()` · `.refsVersion()`.

Events (`Git.on(ev, fn)` returns `off`):

| event | data | when |
|---|---|---|
| `change` | `{ reason, what }` | snapshot or commit list moved (`reason`: open, changed, refs, log, resync) |
| `log` | `{ loaded, complete }` | the commit list grew |
| `files` | `{ paths \| null }` | work tree files changed on disk: re-read open contents (`null` = all) |
| `console`, `job`, `progress` | engine event | for this repository |
| `connection` | `{ state: 'open'\|'lost'\|'reconnected' }` | stream state (a reconnect resyncs by itself) |
| `notify`, `busy`, `select-commit`, `lang`, `skin`, `right`, `log-rendered`, `store` | | UI events |

Resync rules: `changed` with `state`/`worktree`/`op` re-reads the snapshot; `refs` also asks `log.order` and fetches only
unknown commits (`log.commits`); `files` drops cached work tree contents of those paths. An older snapshot never replaces
a newer one; answers for a closed repository are dropped. Tests: `test/ui/store.test.js`.

## 4. Asynchronous content (`content.js`)

```js
const slot = Git.content.slot();               // one per place that shows an answer
slot.run(() => Git.content.details(id), {       // a newer run() makes this answer go nowhere
  loading: () => pane.replaceChildren(Git.content.loading()),          // IntelliJ's "Loading…"
  done: (d) => draw(d),                                                 // cached answers: called synchronously
  error: (err) => pane.replaceChildren(Git.content.failed(err)),
});
```

Getters (Promise, LRU 3 000 entries / 64 MB, failed reads are not cached): `details(id)`, `containing(id)`,
`file({ path, rev | stage | worktree })`, `pair(left, right)` (null side = the file does not exist there; a side's
content is cached on its own, so a local diff and a commit diff share HEAD's), `fileHistory(path, rev?)`,
`blame(path, rev?)`, `search({ text, regex, caseSensitive })`, `paths([paths])`, `compareFiles(a, b?)`,
`compareBranches(a, b)`, `outgoing(branch?)`, `rebasePlan(from)`. Revisions that are not full ids are resolved to the
id they name now (the key never goes stale). Work tree contents are dropped on `files`. Content shape: PROTOCOL
"Content" (`binary`, `tooLarge`, `text: null` for those). `Git.content.missing(source)` = a side that does not exist.

## 5. Commands (`actions*.js`)

Every button and menu item calls `Git.actions.<name>(…)`. A command that talks to the engine goes through one helper:

```js
A.run({ title: t('Push'), method: 'push', params: { branch }, failTitle: t('Push failed'),
        refused: (reason, err) => reason === 'detached' && (showDetachedDialog(), true) })
  .then((res) => { if (res) A.ok(t('Push successful')); });     // null = failed (already notified) or not run
```

`A.run` runs the same command (method + params) once at a time (a second click returns the running promise) and, under
an explicit `id` (an exclusive group, listed at the top of `actions.js`), turns away another command of that group
while one runs; it emits `busy`
(the top bar's spinner), shows a progress balloon for the engine's `job`/`progress` events with Cancel when the job
is cancellable (`job.cancel`), and on failure shows IntelliJ's notification for the error **code**
(`A.errorNotice(err, title, failTitle?)`: git_failed → stderr tail, cancelled, timeout, not_a_repo, unreachable (+ Retry),
busy, refused, not_found; `failTitle` is a whole title used as it is, `title` becomes "{0} failed"). Also:
`A.ok/info/warn`, `A.current()`, `A.blockedByOp()`, `A.running()`, `A.mountGuarded(view, el, arg, name)`.

Shared by every area (integration pass):
- **Refs are pairs** (qa-3 N4, the third round of one class): inside the UI a ref is `{ kind: 'local'|'remote'|'tag',
  name }` (`A.ref(kind, name)`) from the moment it is read from the snapshot (a popup or pane row, a ref label, a menu,
  a chooser's list entry) until the engine call; a revision that is no ref is `{ kind: 'revision', name }`. ONE function
  makes the wire form: `A.wire(ref)` (`refs/heads/` + name, `refs/remotes/` + name, `refs/tags/` + name, a revision as
  typed). No function takes "a name that may already be a full ref": a local branch literally named `refs/heads/x`,
  `refs/remotes/origin/main`, `origin/main`, `-x` or `HEAD` is that local branch. A string handed to a command is text
  the user typed (or an id) and is resolved once against the snapshot (`A.typed`: local, then remote, then tag, else a
  revision sent as typed); a command that only takes a local branch (update, push, rename, Checkout and Update) takes
  its pair or its name (`A.localOf`). Also `A.refLabel`, `A.refId` (the commit a pair names now), `A.sameRef`,
  `A.currentRef()`. Favorites are keyed by kind: `A.favKey` (a remote branch is stored as `.remotes/<name>`, which no
  local branch name can be), `A.isFavorite(ref)`, `A.favorites()`. The Merge / Rebase choosers (`Git.mergeUi.combo`)
  keep the pair of the entry picked from their list (a local and a remote `origin/x` are two entries, the remote one
  with a "Remote" hint); text typed there is `Git.mergeUi.resolveRef` (A.typed, short hashes completed). The Log's
  Branch filter holds pairs from the branches pane and the Branch menu, text from Select… (`L.filterRefId`,
  `L.filterLabel`). `Git.refId` reads full refs exactly (what A.wire makes). Test `test/e2e/branches-refpairs.test.js`,
  `test/ui/refs.test.js`.
- **Exclusive groups and loops** (qa-3 N5): an explicit `id` of `A.run` is a group whose commands must not overlap
  (the list and the rule are at the top of `actions.js`); commands on independent objects (branch create / delete /
  rename, tag create / delete / deleteRemote, conflict accept / resolve / unresolve) carry no id. A loop or chain over
  one group awaits each command (`A.sequence`) and reports ONE notification: Delete of a remote branch with its tracking
  branches ("Deleted remote branch {0}" + "Also deleted local branches: …", Restore), Delete on Remotes, the branches
  pane's Delete Branches (`A.deleteBranches`) and Update Selected (`A.updateBranches`). Test `test/e2e/branches-loops.test.js`.
- **Dialogs that act later** send what they showed and refuse when it is gone (`A.headMark()` when the dialog opens,
  `A.stillCurrent(mark, what)` at the button: "The current branch changed after the dialog opened (a → b). Nothing was
  done."): Merge, Rebase, Reset, Drop; Push and Push All up to Here… send their branch (`push.upTo` gets `branch`) and
  read their list again when the branch moves under them (Push All up to Here… closes when the branch no longer holds
  the commit); Rebasing Commits sends its plan's `head` (head_moved), its plain rebase checks it first; Squash Commits…
  checks its commits are still in the plan. Test `test/e2e/dialogs-stale.test.js`.
- **Engine sentences in the UI**: `A.errorText` gives the reasons a user meets through a field a Turkish / IntelliJ
  sentence (invalid name or revision typed, revision or path not found, nothing to commit, empty message, …); the
  engine's English sentence is the last resort.
- **Autostash**: `A.autostashConflicts(res, { operation, from })` is the one notice for `autostash: 'conflicts'` (the
  operation succeeded, its stash did not come back): a sticky warning "Local changes were not restored" with IntelliJ's
  restore sentence "Uncommitted changes that were saved before {0} have conflicts with files from {1}" and Resolve…, and
  the Conflicts dialog opens by itself (context `{ kind: 'restore' }`: the stash on the left, reversed as IntelliJ's
  GitPreservingProcess). `A.settle` calls it for merge / rebase / update / rebase.applyOnto, the history edits call it
  after their success notice, `op.continue` / `op.skip` after theirs, the commit that concludes a merge, Smart Checkout.
- **A stopped sequence** (`result: 'stopped'`, reason 'would-overwrite', snapshot `op.pending`): `A.sequenceStopped(type,
  res)` ("Cherry-pick failed" / "Revert failed", "Your local changes would be overwritten by …", "However, … succeeded for
  the following commit(s):", Continue / Skip Commit / Abort); `opLabels()` offers Skip Commit while the sequence waits.

- **The engine's last wave (UI adaptation)**:
  - *Half-made operations* (`op.incomplete`): `opLabels()` gives "Unfinished rebase" / "Unfinished merge" with `go: null`
    (no », no Continue / Skip in the popup or the Git menu), the tooltip and `A.incompleteNotice(type)` say what git left
    and offer Abort only; refusals `incomplete_operation` and `op_in_progress` with `data.incomplete` (checkout, merge,
    commit…) are that sentence (`A.incompleteText`). `op.concluded` needs nothing of its own: Continue goes on.
  - *op.abort*: `A.abortedNotice(res)`: `ended` (HEAD had moved) is "Cherry-pick ended" with git's "You seem to have
    moved HEAD. Not rewinding, check your HEAD!", never "aborted"; `undone` (Fixup… aborted) says the commit was taken
    back; an incomplete operation says the local changes are back; `autostash` goes through the shared notice.
  - *Autostash*: `A.autostashConflicts` also covers `'stashed'` (`A.autostashKept`: "They are kept in stash@{0}" +
    "Run git stash pop to get them back": there is no stash UI); a Smart `--no-commit` merge says git holds the
    changes back (`'pending'`).
  - *Would-overwrite*: `A.overwriteLines(what, res)` words `files` (local changes) and `untracked` (ignored files
    included) apart; history edits and cherry-pick / revert notify "Untracked Files Prevent {0}" when only untracked
    content is in the way; `op.continue` / `op.skip` of a rebase answering `stopped` + `would-overwrite` is "Rebase
    failed" with Continue / Abort (the rebase waits); the untracked-files dialog marks ignored paths (not in the
    snapshot's `?` list) and offers Force Checkout where the method has `force` (its trash: Restore).
  - *Saved content on errors*: `A.run` adds `data.trash` (Restore) and `data.autostash` ("Your local changes are kept in
    stash@{0}.") of a `git_failed` / `cancelled` / `timeout` error to the notification the command shows, once, for
    every command; refusals `special_file` and `not_ignorable` are sentences (`A.errorText`; `A.reasonText` falls back to
    it); Restore says what it moved aside (`replaced`) and Undo restores the entry it returned; Restore of a deleted
    branch passes `upstreamRef`; `conflict.resolve` and `changes.applyFromCommit` results offer Restore.
  - *Jobs*: the progress balloon appears once a job has run `A.JOB_DELAY` (400 ms) — no flash for fast commands — with
    Cancel while the job is cancellable; `cancelled` is IntelliJ's info ("Commit canceled", "{0} canceled" for
    cherry-pick / revert: `A.run`'s `cancelTitle`; else "{0} cancelled"); a late cancel shows the real result.
  - Tests: `test/e2e/ops-incomplete|ops-overwrite|ops-results|ops-trash|ops-jobs.test.js`.

Areas: `actions-changes.js` (working tree), `actions-history.js` (Log + history), `actions-op.js` (the ongoing
operation), `actions-branches.js` / `actions-remote.js` (branches, tags, remote, merge/rebase entry points).

## 6. Workbench (`workbench.js`) and tabs

URL: `index.html?repo=<path>&view=commit|log|console|branches|files&skin=default|intellij&lang=en|tr`. Without `repo`: the last
one (`Git.host.prefs` `lastRepo`), else the first existing recent one, else the picker (`picker.js`). States:
loading, engine unreachable (Retry), not a repository (picker with the error), empty repository ("No commits yet").

- Center tabs: `Git.tabs.open({ id, title, icon, closable, mount(el), unmount() })` (same id → brought forward, not
  remounted; `remount: true` to replace) · `.close(id)` · `.select(id)` · `.active()` · `.list()` · `.setTitle(id, t)`.
  Diff tabs: `Git.diffTab.open(spec)` with `{ kind: 'local', path, files }`, `{ kind: 'commit', commit, path, parent?,
  files }`, `{ kind: 'file', path }` (→ `Git.fileView`, §11), `{ kind: 'texts', id, title, left, right }`; binary, too
  large, "too big to diff" and "only line separators / whitespaces" show IntelliJ's messages.
- Git tool window: `Git.frame.openTab({ id, title, closable, mount(el) → off? })`, `.selectTab(id)`, `.closeTab(id)`,
  `.setTabTitle(id, title)`, `.toggleGit(open?)`, `.activeTab()`, `.isGitOpen()`. Right column (one tool window at a
  time, as IntelliJ's side group): `Git.frame.showRight('commit' | 'files' | 'none', 'toggle'?)`, `Git.frame.rightView()`;
  stripe buttons Files (⌘1) and Commit (⌘0). `Git.frame.setSkin(skin)`, `Git.frame.rebuild()` (language/skin change).
- Splitter sizes and choices persist through `Git.host.prefs` (`size.<key>`, `wb.right`, `wb.rightView`, `wb.git`, `log.opts`,
  `skin`, `lang`, `commit-group`, `commit.messages`, `diff.settings`).
- Single view: one view fills the page and works at 300 px (the Log stacks its panes in its narrow and medium
  arrangements, §13.3). What needs another
  view goes through `Git.host.hooks`: `showInLog(id)`, `branchFilter(names)` (host-defined; absent = nothing happens).
- Single view pages (`pages.js`): a single view has no editor area and no Git tool window, so `Git.tabs.open` and
  `Git.frame.openTab` there push a **page** that covers the view: a header like the view's own (`.wb-rhead`: Back, the
  tab's title with an ellipsis) over the tab's content. The view stays mounted under it (inert, selection, scroll,
  filters and drafts untouched). Pages stack; Back or Esc (after menus, popups and dialogs, and unless the content
  took the key) closes the top one (`unmount` / `off` is called) and focus returns where it was. An id already in the
  stack is brought to the top and refilled as the workbench does an existing tab. `Git.tabs.close/select/active/list/
  setTitle` and `Git.frame.closeTab/selectTab/setTabTitle/activeTab` work on pages (`selectTab(<the view>)` closes
  them: Show in Log). `W.open`, `W.picker`, the whole-page states and `F.rebuild` close every page. `Git.pages.list()`,
  `.top()`, `.closeAll()`. The diff viewer in a page narrower than 700 px draws the unified mode (the stored setting is
  kept; the switch shows unified, disabled, "Side-by-side needs a wider panel") and its toolbar tightens, then wraps
  (container queries in `workbench.css`). In the full workbench nothing of this runs. Tests: `test/e2e/single-pages.test.js`.
  `?view=tab` is a host's own tab view (`Git.views.tab`, registered by the host): its first page has no Back (it names
  itself in a slim line unless it is a plain diff, `spec.plain`), pages opened from it stack with Back, Back and Esc
  stop at the first page; the host replaces everything with `Git.pages.closeAll()` and a new opener.
- **Openers** (`openers.js`): every entry point that opens a tab or a page is `Git.open(name, args)` with plain JSON
  arguments (`diff`, `file`, `texts` with its two sides as `{ path, rev }` / `{ path, worktree }` descriptors loaded
  where it runs, `history`, `compare`, `branchDiff`, `repoAt`, `versions`; `Git.openers.define(name, run)` next to the
  code they open). `Git.host.forward(name, args)` → truthy (or a promise of it) means the host shows it elsewhere (Orca:
  the center tab, `hosts/orca/README.md`), and it runs the same opener there (`Git.openers.run`). Not taken, or a
  failure: it runs here (page, or the workbench's own tab). Not openers: dialogs' own viewers (merge), Annotate, Diff
  for Range.
- `Git.product()`: the product name in messages (`Git.host.product`, default "Git Panel", `ui/host/product.js`).
- The loading page ("Loading X…") shows its text only after 400 ms (`.wb-loading`): a quick panel boot does not flash it.
- The host's look (`look.js`): `Git.host.look()` → `{ code: { family, size, lineHeight }, ui: { family }, icons }` (or a
  promise of it, or null), `Git.host.onLookChange(fn)`; written as inline `--gd-font`, `--g-mono`, `--gd-size`,
  `--gd-line`, `--g-font` on `<html>`, over both skins. A view that computes with a font metric reads the variable
  when it draws and redraws on `Git.on('look')` (the diff, the file view); a change of `icons` redraws the page. File
  icons: `Git.fileIcons.html(name, { dir, expanded })` asks `Git.host.fileIcon` first (HTML or null), else Seti for a
  file and '' for a folder (IntelliJ's `nodes/folder`). `Git.tree` asks for the folder icon of a `nodes/folder` row
  (not kind `folder`: branch folders) with its open state; `Git.folderIcon(name, expanded)` outside a tree.
- `Git.host` (host script, before the UI): `openFile(path, { line })` → handled?, `openExternal(url)`, `copy(text)`,
  `prefs.get(key, fallback)` / `prefs.set(key, value)`, `hooks`. `Git.backend`: `call(method, params)` → Promise
  (rejects with `{ code, message, data }`), `on(event, fn)`, plus `reconnect()` and `client()` in the standalone host.
- **Report a Problem** (`report.js`; the owner, 17 Nov 2026). Only with a host that offers `Git.host.report =
  { diagnostics() → Promise<{ environment: [line], lines: [line] }>, url(title, body) → string | null, where, max }`.
  `Git.report.open()` is a dialog that asks the person for one thing (three fields, Summary / What happened / Steps,
  were too many: the owner, 17 Nov 2026), in this order: one sentence saying what a report carries; **What
  happened?** (a multiline field; its first line is the report's title); the screenshot area (below); one sentence
  saying what the plugin adds by itself, with a "Show them" link that unfolds it whole and selectable (it is not
  laid out by default: the owner, 17 Nov 2026): the Environment (the host's lines, then this page's: the view, its
  size, the labels' language) and, after an empty line, the diagnostics (the host's, then the page's: mode and how
  long the page took to show, its element count and heap; the repository as numbers; the page's own calls by name,
  outcome and time, the slowest and the failed ones; the last
  five errors by name with up to three of the plugin's own frames and their age); one hint; Cancel / Copy / "Report
  on {where}". `Git.backend.call` is wrapped once to note each call's name, outcome and time (the caller gets the
  same outcome; nothing of the parameters or the answer is kept). The report's text is Markdown in the shape of a bug report form: `### What happened`, `### Screenshot`
  (only for a tracker that takes pictures), `### Environment` as a list, and the diagnostics in a code block inside
  `<details>`; a part left empty reads `_No response_`. Copy hands that text, with the title as a first heading, to
  `Git.copy`; a host names its tracker as `github` (a repository's new-issue page: `report.js` then spells the
  link, `title` and `body`, and knows how long a link GitHub takes, measured) or gives a `url` and `fits` of its
  own. "Report on …" builds `url(title, text)` (title: the first line of what happened, 120 characters, else
  "Problem report") and calls `Git.host.openExternal` straight from the click. The text a link carries is the same
  report written for a link (`compose` with `link`): the person's words first and without a heading,
  `**Environment**` on one line and a plain sentence, then the two `<details>` blocks, the plugin's own lines with
  plain letters for `×`, ` · ` and `…`; a host may show the link's beginning to the person, and it may write the
  link to be read (letters as they are). Whether a link is short enough is the host's `fits(url)`, else `max` (6500)
  on the link's standard spelling. A link that is too long gets the person's text shortened (marked ` […]`) until
  it fits, and the whole report goes to the clipboard, which the notice says. Nothing is sent by the page. `openExternal` may answer a Promise of `false` (the host asked the person and they
  said no): the dialog then stays open with everything in it and says the page was not opened; it closes, and a
  picture goes to the clipboard, only once the page opened. `asks()` adds the host's sentence about that question
  to the hint.
  **The detailed log** (the owner, 17 Nov 2026: the diagnostics are a summary, a report must carry the plugin's own
  detailed account): `diagnostics()` may answer `detail: { head, tail }` (the host's sections, and its timeline
  newest first); the page adds its own sections (`pageDetail()`: `[page]`, `[page settings]`, the repository line,
  `[page calls by method]` with n, failed, p50, p95 and max per method, `[page errors]`, `[page calls]` newest
  first). Unfolded in the dialog ("Show them") and copied, it is whole, in a `<details>` block of its own. In a link
  it is readable too (the owner, 17 Nov 2026: an issue must bring the log with it, and not as a code): as many of
  its lines as fit beside the person's text, the Environment and the diagnostics (those keep 1500 characters, then
  1000, then 600, their last lines giving way), found by halving, with a last line that counts what stayed behind.
  A link is cut from its end, so its order is the sections, the host's timeline, then `[page calls]`.
  **A screenshot** (the owner, 17 Nov 2026: reporters should be able to send one, and the dialog must show
  where it goes): a link carries text only, so the picture needs a host that can carry it. With `report.picture`
  (`{ set(base64 PNG), copy(), clear() }`) the dialog has the screenshot area (`report-picture.js`): a dashed box
  ("Add screenshots: drop pictures here, click to choose files, or paste one") that opens the system's file picker
  on a click or Enter (several files at once) and takes pictures dropped anywhere on the dialog or pasted while it
  is open, up to six (the owner, 17 Nov 2026: one is not enough). Each is listed above the box with its thumbnail,
  name, size and a remove button. A tracker's page takes one picture from a paste, so what is handed to
  `picture.set` is ONE PNG, made again after every change of the list: a single picture as it is, several joined one
  under the other with a grey band between (2200 px a side per picture; 12 000 px and 3.5 MB for the whole); the
  line under the box says so ("3 pictures, joined into one image: …"). "Report on …" stays off while that runs. On the click the page opens with the line "Screenshot: it
  is on your clipboard…", then `picture.copy()` runs and the notice says to paste it there (or, when the copy failed,
  to drop the picture onto the page); a text too long for the link is then left out rather than copied, the
  clipboard is the picture's. Without `picture` but with `report.images` the dialog only says where a screenshot
  goes on the tracker's page (and, with `report.open`, that what is sent there is public). **What a line may hold: versions, kinds, counts, error names; never a folder path, a project, workspace,
  branch or file name, an id or content** (an error is its name and the plugin's own file and line, a notice its
  code). Entry points: `Git.report.menu()` at the end of a single view's menus (Commit and Log View Options, the
  diff's Settings) and of the workbench's Settings menu; `Git.report.link()` on the picker's question page and on
  its error page. Without `Git.host.report` none of them shows. Tests: `test/hosts/orca-report.test.js`.

### Worktrees (`worktrees.js`; docs/ARCHITECTURE.md §6.3.1)

IntelliJ's Worktrees list (help "Use Git worktrees") for looking, plus two things IntelliJ lacks: each row's change
count, and showing another worktree in this same page (IntelliJ opens another window).
- **Chip**: `Git.worktrees.chip()`, a `.wb-repo` chip with the word "PR" and the number of worktrees ("PR 23"; the
  owner, 17 Nov 2026: the worktree icon beside a number told nobody what it was, and for him a worktree is a pull
  request being worked on; the tooltip, the label for assistive technology and the list still say Worktrees), in
  the workbench's top bar after the repository chip and in the single views' headers (Commit always; Log and Files
  beside a host's repository chip). Hidden while the repository has one worktree. A dot at the word's corner: the
  last opening of the list found changes in another worktree than the shown one (it does not update by itself).
  **A narrow panel** (a single view up to 620 px wide, `workbench.css`): when the Commit view's header has a project
  chip or this chip, they and the branch widget go to a line of their own under the tabs and Options, and a part
  that still does not fit goes to the next line: nothing is cut to a few letters. With neither chip the header is
  the one line it was. `test/hosts/orca-header-narrow.test.js`. The list is read without counts (`worktree.list` with `counts: false`: one
  `git worktree list`, no status anywhere) when a chip is drawn (at most once in 2 s), at most every 15 s while the
  shown repository changes, when the page shows again, and when a host looks up a folder (`Git.worktrees.load(force)`);
  such a read keeps the counts the last opening found. Only opening the list counts
  (`Git.worktrees.load(true, { counts: true })`): a status in every worktree, seconds with two dozen of them (17 Nov
  2026). The last list of a repository (without counts) is kept in localStorage so a new frame shows the chip at once.
- **List**: the shell menu (`Git.menu(anchor, items, { width })`; rows with `bold`, `hint`, `tag`, `badgeHTML`, `key`,
  menu.js). One row per worktree in git's order: the directory name (bold for the main worktree), its branch or the
  short hash, a quiet "home" tag on the page's home, a lock icon when locked, "N changes" at the right (nothing when
  clean or unread; "·" while the counts of this opening are read; the width is laid out for "999 changes", so nothing moves when
  counts arrive, and the open list's counts are updated in place). The check marks the shown one; prunable rows are
  dimmed and cannot be picked; the tooltip is the path and IntelliJ's words: main / linked, locked, prunable.
- **Home and pick**: `Git.workbench.open(path)` opens a home; `Git.worktrees.show(path)` is `open(path, { pick: true })`
  and keeps the home (URL `repo`, `lastRepo`). The pick is stored per view (`<prefix>worktree.shown:<view>`: home path,
  home root, shown root); a home open of the same home shows it again, of another one forgets it; a kept worktree
  that cannot be opened any more is forgotten and the home opens. A pick that fails says why and goes home.
- **Strip**: `Git.worktrees.strip()` under the header (and under a page's head in a single view) while
  `Git.worktrees.away()`: "Showing worktree <name> <branch>" and "Back to <home>". Committing there is allowed and
  works on that worktree. Nothing in it is cut: under 600 px the words "Showing worktree" give their room to the
  names, the branch goes to a line of its own when it does not fit beside the name, and a name longer than a line
  breaks (`test/e2e/worktrees-strip-narrow.test.js`).
- Hosts that send openers elsewhere check `Git.worktrees.away()` (Orca's panels keep the page inside).
- Not now: creating, deleting, locking, pruning; a Worktrees tab in the wide tool window; which agent session owns a
  worktree.
- Tests: `test/core/worktree-list.test.js`, `test/core/worktree-counts.test.js`, `test/e2e/worktrees.test.js`,
  `test/e2e/worktrees-counts.test.js` (a page show runs no status in any worktree), `test/hosts/orca-worktrees.test.js`.

## 7. Shared components (`ui.js`, `vlist.js`, graph)

- `Git.h`, `Git.clear`, `Git.icon(key, size)` (keys: `icons-keys.md`), `Git.btn`, `Git.toolBtn`, `Git.checkbox`,
  `Git.radio`, `Git.field`, `Git.menu(anchorOrEvent, items)` (the pop-up menu, `menu.js`), `Git.popup`, `Git.dialog`,
  `Git.confirm`, `Git.notify({ kind, title, text, actions, sticky, progress })` → handle with `close()`/`update()`,
  `Git.splitter`, `Git.tree` (virtual; `el` must be a scroll container with its own height; `dragSelect` +
  `tree.keepSelection()` for a tree whose rows can be dragged), `Git.formatDate`,
  `Git.fileName/dirName`, `Git.copy`, `Git.statusColor`, `Git.fileIcon(path)` (Seti theme),
  `Git.isEditable(el)`, `Git.focusSink(kind)`.
- `Git.vlist({ el, rowHeight, count: () => n, render: (i) => element, overscan, tall?: () => [i, height] })` → `{ refresh(), update(i),
  scrollTo(i, { align }), visibleRange(), rendered(), rowElement(i), each(fn), destroy() }`.
- **Redraw only what changed** (busy repositories render on every status and refs event; rows replaced under the wheel
  make scrolling stick): `Git.tree.render()` keeps the rows in the DOM when the rows it would draw have the same
  signature (ids, depth, open state, label, icon, dim, colors, checkbox, selection) and points them at the new nodes;
  the Log table refreshes its rows only for a new view object or other columns, options or language; Commit Details
  draw again only when the commits, their loaded details or their own refs change, and re-ask "In branches" in place
  when a ref tip moved anywhere. Tests: `test/e2e/log-scroll.test.js` (rebuilds counted with a MutationObserver).
- **Splitters** (`Git.splitter`): pointer events with capture on the handle; a drag ends on pointerup, pointercancel,
  a lost capture, a window blur or a move with no button down (a button released outside a host's frame), and the size
  is stored then. A press that moves less than 2 px resizes and stores nothing. With `onReset` a double click forgets
  the stored size and the owner shows its default; `onStart` runs before a drag's first resize. A wheel over a
  handle's hit area scrolls the pane under it.
- `Git.graph.create(order, { parents: id => [...], refs: id => [...], longEdges, dotted: (id, p) => bool })` →
  `{ rowCount, row(i), rows(from, to), width(from, to), indexOf(id), recommendedWidth }`; `Git.graphPaint.row(g, i, ROW)`.
  For a filtered list pass the visible order, the filtered parents and `dotted` (see `log-view.js`, which computes the
  nearest visible ancestors in one pass). `Git.graph.layout` is the old all-rows form: do not use it for the Log.

## 8. Languages and the Turkish glossary (binding)

### Adding a language

English is the key language: labels are IntelliJ's English text, and a language is a table from that text to its own
(`lang.js`). English is the default; a stored choice wins (`Git.host.prefs` key `lang`), `?lang=<code>` picks one, and
an unknown code is English.

1. Write one file per language, e.g. `ui/git/lang-de.js`, loaded after `lang.js` (in `ui/index.html`; the Orca list
   follows it, `node tools/orca-paket.mjs`):
   `Git.addLang('de', { name: 'Deutsch', locale: 'de-DE', dates: 'dmy' }, { 'Commit': 'Commit', 'Push…': 'Push…', … })`.
   `name` is what the language menus show, `locale` formats numbers and upper-cases text, `dates` orders a short
   date (`mdy` 11/14/25, `dmy` 14.11.2025). Calling `addLang` again with the same code adds labels.
2. Labels missing from the table show in English. Do not touch the call sites or the `Git.addTR` tables.
3. The language appears in every language menu by itself (`Git.languages()`): the workbench's Settings menu; in a
   single view the header's Options button (⋮, `options.js`: `Git.options.button()` at the right end of the
   `.wb-rhead` a single view has, with the language, Report a Problem… and the product with `Git.host.version`); in
   the center tab and a page's diff the diff's Settings menu (`Git.languageMenu()`). A single view without a header
   (a Log with no project chip) has no such button: there the rows stay at the end of View Options
   (`Git.options.rows()`). A pick redraws the page (`Git.switchLang`) and other frames that share the storage follow
   its `storage` event.

### Turkish glossary

Git terms are not translated: Commit, Push, Pull, Fetch, Merge, Rebase, Cherry-Pick, Amend, Squash, Fixup, Drop,
Reset, Revert, Stash, HEAD, Log, diff, hash, Worktrees (and IntelliJ's worktree words main, linked, locked, prunable).
Suffixes with an apostrophe: "commit'i", "diff'i", "HEAD'e". Sentence
case, no final period, the `…` character.

| English | Türkçe | English | Türkçe |
|---|---|---|---|
| Changes | Değişiklikler | Unversioned Files | Takip edilmeyen dosyalar |
| Commit Message | Commit mesajı | Commit and Push… | Commit ve Push… |
| Rollback… / Rollback | Geri al… / Geri al | Show Diff | Diff'i göster |
| Jump to Source | Kaynağa git | Refresh | Yenile |
| Expand All / Collapse All | Tümünü aç / Tümünü kapat | Group By / Directory | Grupla / Klasör |
| Branch / Branches | Dal / Dallar | New Branch… | Yeni dal… |
| Local / Remote / Tags / Recent | Yerel / Uzak / Etiketler / Son kullanılanlar | HEAD (Current Branch) | HEAD (geçerli dal) |
| Update Project… / Update | Projeyi güncelle… / Güncelle | Compare with '{0}' | '{0}' ile karşılaştır |
| Rebase '{0}' onto '{1}' | '{0}' dalını '{1}' üzerine rebase et | Merge '{0}' into '{1}' | '{0}' dalını '{1}' içine merge et |
| User / Date / Paths | Kullanıcı / Tarih / Yollar | Today / Yesterday | Bugün / Dün |
| Copy Revision Number | Commit hash'ini kopyala | Conflicts | Çakışmalar |
| Accept Yours / Accept Theirs | Seninkini al / Onlarınkini al | Resolve / Continue / Abort / Skip | Çöz / Devam et / İptal et / Atla |
| Cancel / OK / Close / Apply | Vazgeç / Tamam / Kapat / Uygula | Loading… | Yükleniyor… |

## 9. Tests

- Logic without DOM: `node --test test/ui/` (graph, diff, store with a fake backend).
- e2e (`npm run test:e2e`, `test/e2e/helper.js` has the pattern at its top): a fresh demo repository in a temp dir,
  engine + server on port 0 in the test process, the real page in `tools/sayfa-cek` (off-screen WKWebView), page-side
  helpers `T` (`test/e2e/page-helpers.js`: wait, click, dblclick, rightClick, type, key, rows, treeRows, menu,
  menuClick, focus, idle), assertions in Node, the repository checked with plain git afterwards. To change files while
  the page runs: the step calls `await Git.backend.call('app.info', {})`, the test does
  `srv.when('app.info').then(() => repo.write(…))`. Manual runs: `node test/e2e/try.mjs [--big] js:<file> shot:<name>`.
  Screenshots land in `$GIT_PANEL_E2E_OUT` (default `<tmp>/git-panel-e2e`): look at them.
- Every e2e test asserts `r.errors` is empty (console errors and uncaught exceptions of the page).

## 10. Calls still on the prototype's model

None: every command reaches the engine through `A.run` (the old `A.notWired` / `TODO(wave3)` call sites are gone).
`test/ui/translations.test.js` keeps one Turkish text per English label across the files.

## 11. Working tree area (Commit view, diff, rollback, file view, blame, Files)

- **Commands** (`actions-changes.js`, all through `A.run`): `commit(paths, message, { amend, push, mergeCount })` →
  result | null (refusals `empty_message`, `nothing_to_commit`, `nothing_to_amend`, `unresolved_conflicts`,
  `op_in_progress` and a failing hook (`git_failed`, its whole output) are notified as IntelliJ does; success: "N files
  committed" + the subject, "Edit Commit Message…" when the Log offers it; `push` opens `Git.dialogs.push(branch)`);
  `rollback(paths)` (dialog) · `doRollback(paths, deleteAdded)` · `addToVcs(paths)` · `deleteFiles(paths)` (asks:
  `Git.dialogs.deleteFiles(paths, { folder })`) · `doDelete(paths)` · `writeBlock(path, text, expect, 'revert'|'append')`
  (changes.write) · `touched(paths)` (drop cached work tree contents + emit `files`: call it after any write the snapshot
  may not show) · `resolveFromCommitView()` (`Git.dialogs.conflicts`, else `A.resolveConflicts`) · `addToIgnore(paths,
  'gitignore'|'exclude')` (`changes.ignore`, emits `ignored`) · `checkinProject()` (⌘K and every "Commit…": the right
  column shows the Commit view, every change is ticked, the field takes focus) · `commitFiles(paths)` (Commit File…:
  exactly these ticked) · `showDiffInNewTab(path)` (a `diff:local#<n>` tab of its own). Every result with `trash`
  notifies with "Geri getir", which restores and refreshes open contents. A refused commit with unmerged paths is
  "Commit failed" / "Committing is not possible because you have unmerged files." (GitBundle).
- **Commit view** (`commit*.js`): state in `Git._commit.S` (ticked paths, Amend, message); node ids `changes`,
  `conflicts`, `unversioned`, `amend`, `ignored`, `f:|u:|c:|a:|i:<path>` (change, unversioned, conflict, the amended
  commit's file, ignored entry), `d:<set>:<dir>` when grouped. `Git.views.commit.order()` (the diff's file order),
  `.included()`, `.optionsMenu(anchor)` (the header's ⋮: Show on Double-Click ▸ Diff | Source, prefs `commit.dblclick`),
  `.locate()` (Select Opened File in Changes View). **Drag and drop** (`commit-drag.js`, IntelliJ's ChangesDnDSupport for
  the two nodes): file and folder rows (a selected row drags the whole selection) onto the area of the other node —
  Unversioned Files → Changes is Add to VCS (`changes.add`); Changes → Unversioned Files is taken only when every
  dragged file is newly added (`changes.unversion`: out of the index, the file on disk untouched), otherwise refused
  (no highlight, not-allowed cursor). Pointer events, captured after 4 px (click, double click, checkbox, context menu
  and wheel unchanged; the tree's `dragSelect` keeps a multi-selection on the press); the drag holds paths and finds
  the target under the pointer at every move and at the release, so a redraw mid-drag changes nothing; Esc, blur, a
  lost capture or a release outside the frame cancel it. Highlight: `--g-dnd-row` / `--g-dnd-border`
  (DragAndDrop.rowBackground / borderColor); the label is the file name, or "{0} files". Toolbar: Refresh, Rollback…, Show Diff, View Options (Group By ▸
  Directory; Show: Ignored Files, prefs `commit.ignored`, read with `files.ignored`), | locate, Expand All, Collapse
  All. The file menu follows ChangesViewPopupMenu (conflicts first: Merge…, Accept Theirs, Accept Yours; then Commit
  File…, Rollback…, Show Diff, Show Diff in a New Tab, Jump to Source, Copy Path/Reference…, Delete…, Add to VCS, Add to
  .gitignore ▸, Refresh, Git ▸). The merge message is the snapshot's `op.message`; resolved conflicts are ticked; a
  detached HEAD asks first ("Commit Anyway"); unresolved conflicts give the inline reason "Files have unresolved
  conflicts". **After a commit the message stays in the field** (IntelliJ's default; typing or the history replaces
  it). That kept message is not the user's draft until it is edited (`S.kept`): a message git prepares later
  (`op.message`, `pendingMessage`: a squash merge, `cherry-pick -n`) replaces it — never a draft — and when the prepared
  message goes away untouched the field shows again what it showed (`S.underMerge`); Amend always loads the amended
  commit's message and Amend off brings the field back (qa-3 N13, `test/e2e/changes-prepared-message.test.js`). Message history: prefs `commit.messages` (25, newest first) + my recent subjects. The tick state is shared with
  the diff's header box through the `included` event. Header (workbench): the title through `Git.t` (capitals by CSS in
  the default skin), ⋮ Options and — Hide. Balloons sit left of the right column (`--gc-right-edge`).
- **Git ▸ and shared menus** (`changes-menus.js`): `Git.changesMenus.gitItems(sel)` = Git.ContextMenu: Commit File…,
  Add, Add to .gitignore ▸, | Annotate with Git Blame (or Close Annotations), Show Diff, Compare with Revision…,
  Compare with Branch or Tag…, Show History, Show Current Revision, Rollback…, | Push…, Pull…, Fetch, | Merge…,
  Rebase…, | Branches…, New Branch…, New Tag…, Reset HEAD… (the other areas' `Git.dialogs.*` / `Git.actions.*`);
  `.copyPath(at, paths)`, `.ignoreItems(paths)`, `.compareWith(path, ref, label)` (a `texts` tab `diff:with:<path>`),
  `.compareWithRevision(path)`, `.compareWithBranch(at, path)`, `.showCurrentRevision(at, path)`.
- **Diff** (`diffview*.js`): `Git.diffTab.open(spec)` (§6; `spec.tabId` names a tab of its own);
  `Git.diffTab.tab('diff:local').revert(blockIndex, append)`; settings in prefs `diff.settings` (mode, ignore,
  highlight `lines|words|split|chars|none`, collapse, sync, align). Toolbar (new design, `diffview-bar.js`): ↑ ↓ | ✎
  (⌘↓) | ← "{1}/{0} files" → | Collapse Unchanged Fragments … count, Side-by-side / Unified, Settings gear (side by
  side only: Synchronize Scrolling, Align Changes In Side-by-Side Diff; then Ignore Differences and Highlighting
  Differences in IgnorePolicy / HighlightPolicy order). Context menu on a line: Revert ⌃⌘→, Append, | Annotate with
  Git Blame, | Previous / Next Difference, Jump to Source; on the gutter: Annotate with Git Blame. Keys: F7 / ⇧F7, ⌘↓ /
  F4, ⇧⌘[ / ⇧⌘], ⌃⌘→. The local diff's right header has the "Include into commit" checkbox (the whole file). CRLF sides
  compare as LF ("only line separators" notice); a block written back goes through `Git.changesModel.writeBack` (the
  one write-back of the diff's » and the file view's Rollback Lines: a CRLF file gets CRLF back, a file with mixed line
  ends keeps every untouched line's own end, the BOM and the final-newline state; `test/ui/changes-writeback.test.js`
  is a property test of it); `expect` = `Git.changesModel.expectOf(right.text)`. No difference shown although the texts
  differ (the ignore policy hid them): the count says "Differences ignored"; a diff shown as a message ("Unable to
  calculate diff…", binary, identical) has an empty count.
- **File view** (`fileview.js`): `Git.fileView.open(path, { line, rev, annotate })` → tab `file:<path>` or
  `file:<path>@<rev>`; `.tab(key)`. Markers against HEAD for the work tree file (`marks.blocks`). A click on a marker
  opens the marker popup (`fileview-marker.js`, `Git.fileMarker.open(view, k)`): Previous / Next Change, Rollback Lines
  (writeBlock: trash + Restore), Show Diff for Lines (`texts` tab `diff:range`, "Diff for Range": Base revision |
  Current), Copy, Highlight Words, and HEAD's old lines; ⌃⌥⇧↓ / ⌃⌥⇧↑ step through the changes. **Annotate**
  (`annotate.js`, engine `annotate`): the column right of the line numbers; bold + "*" on the file's current revision
  (`annotate`'s `current`); `Git.annotate.toggle(path, { rev }?)`, `.open(path, { rev, line })`, `.isOn(key)`,
  `.menu(view, ev)`, `.opts` (prefs `annotate.opts`); click → `A.showInLog(id)`. Its gutter menu: Annotate Revision,
  Annotate Previous Revision, Copy Revision Number, View ▸ (Revision, Date, Author, Commit number, Names ▸), Colors ▸
  (Author, Order, Hide), Options ▸ (Ignore Whitespaces, Detect Movements Within File, Detect Movements Across Files,
  Show Commit Timestamp), Close Annotations.
- **Files** (`filetree.js`): `Git.views.files.mount(el)` → off, `.reload()`, `.reveal(path)`, `.index()`; rows
  `d:<dir>` (root `d:`), `f:<path>`; ignored files and folders (`files.ignored`) in the ignored color, an ignored
  folder read when it opens; context menu Jump to Source, Delete…, Git ▸ (the shared `gitItems`).
- **Engine additions** (`core/read/extra-changes.js`, `core/ops/extra-changes.js`, PROTOCOL): `files.ignored`,
  `annotate`, `changes.ignore`, `changes.write`; `changes.lineStats` (`core/read/line-stats.js`) for the Changes row.
- **Changes row line counts** (the owner, 18 Nov 2026; not in IntelliJ): `Changes  5 files  +120 −34` (`.gc-lines`,
  `--g-added` / `--g-error`): the added and deleted lines of the files in the Changes group, HEAD against the work tree
  (unversioned files and conflicts not counted, binary files left out; no numbers when nothing countable changed).
  Read on its own after a snapshot or a changed file's `files` event (300 ms debounce), never while there are no
  changes or more than 5 000 of them.
- **Tests**: `test/core/extra-changes*.test.js`, `test/ui/changes-model|changes-diffmodes.test.js`; e2e `changes-*.test.js`
  and `commit.test.js`.
- **Known deviations from IntelliJ** (kept on purpose or not done):
  - The Commit tool window sits in the right column (the approved prototype; its host's project menu is on the left).
    The Files tool window stands for IntelliJ's Project tool window under the prototype's name.
  - Not offered: Compare with Clipboard, the diff's "?" help, editor appearance settings (line numbers, whitespaces,
    soft wrap), Show Diff in Separate Window, Ignore formatting / language-specific changes (need a parser), ⇧⌘D, ⌃⇧Tab,
    the commit balloon's "More ˅" (the spec does not list its items), the commit options gear (Author, Sign-off: needs
    `changes.commit` parameters; the owner decides), the Options menu's View Mode / Close Tool Window After Committing
    (no window modes) and the "single-click diff preview" option (no IntelliJ label in the spec; the preview rule itself
    is built in: while a diff shows in the centre, a click or an arrow key in the Commit tree or the Log's changed
    files switches it, `centre.js`, docs/ARCHITECTURE.md §6.2 "Centre presence"), Hide Revision of the
    annotations, the per-block checkboxes and every changelist / shelve / patch / partial-commit item (out of scope).
  - "Annotate with Git Blame" in a diff pane opens the annotated file view (IntelliJ annotates the pane in place).
  - "Pull…" in Git ▸ stays disabled until the branches area offers `Git.dialogs.pull`; "Reset HEAD…" opens the Log's
    Reset dialog for HEAD; "Commit…" of the Branches popup (`branches.js`) still only opens the view
    (`Git.actions.checkinProject` is the call for it).
  - The base's own texts (not IntelliJ's): "There is no commit to amend yet", "Commit message changed", "{0} files
    rolled back", "{0} files deleted", the Delete dialog's note about the trash, "Change reverted" / "Change appended"
    and "Restore" ("Geri getir"): the trash is the engine's addition.
  - The order of the annotation menu's items is not in the spec (only the items); the order here is a choice.
- **QA fixes** (qa-2): a final newline on one side only is a change of the last line (`m.noEol`, the note "No newline
  at end of file", `applyBlock` writes the newline state back); the Delete dialog names folders ("Delete directory
  "{0}"?", counts of files and directories); a nested repository deleted from the Commit view is saved whole (trash
  `trees`, `.git` included) and Restore brings its history back; Amend sends `expectHead` (the commit it loaded) with
  `changes.commit` and, on `head_moved`, follows the new last commit (the field keeps the message), also before the
  Log lists that commit. Tests `test/e2e/changes-qa.test.js`, `test/ui/changes-diffmodes.test.js`.
- **Integration pass**: Restore (`A.restoreTrash`) reads `trash.restore`'s `blocked` / `complete`: a partial restore is a
  warning "Partly restored: …" that lists what was not written and why (a folder / a file in the way, something in a
  saved tree's place, restored before), nothing written is "Nothing was restored"; Rollback of a submodule whose checkout
  moved (`skipped`) is not counted ("Not rolled back: sub. Rollback does not change a submodule's checkout."); committing
  during a rebase (an edit stop) asks first with IntelliJ's "Rebase in progress in the repository: {0}. Committing during
  rebase may lead to the commit loss." (Commit Anyway). Tests `test/e2e/ops-outcomes.test.js`,
  `test/e2e/rebase-stop-edit.test.js`, `test/e2e/changes-qa.test.js`.

### 11.9 Stash (`actions-stash.js`, `stash-dialogs.js`, `stash-view.js`; spec `docs/spec-stash.md`)

- **Stash tab**: the Commit view's header shows Commit | Stash (the tool window tabs, `.g-tab`) while `Git.repo.stashes`
  (the snapshot's stash ids) is not empty, in the workbench's right column and in a single `commit` view
  (`Git.stashTab.attach({ head, commit, stash })`); it hides with the last stash unless it is the tab being looked at
  (then the empty text "No stashes or shelves added." with "Getting started with Stash and Shelf"). The chosen tab is
  `prefs` `commit.tab`. Top: the stashes (message, grey date and time, the branch label with the tag icon, tooltip
  "stash@{n} created on …"); bottom: the selected stash's files (Group By Directory, "Index on …" / "Untracked files
  on …" nodes, Show Diff / View Options / Expand All / Collapse All), the Apply / Pop strip with the help icon. Row menu:
  Pop, Apply, Unstash…, Drop (⌫), Clear, Show Diff, Show Diff in a New Tab, Compare with Local. Double-click or Enter
  on a row shows its first file's diff; on a file, that file's. A line under the list says the stashes are shared by
  all worktrees when the repository has more than one.
- **Diff**: `Git.open('diff', { kind: 'stash', stash, ref: 'Stash@{n}', part, rev, path, files, changes })`
  (`diffview-load.js`): the local file on the left ("Current version"), the stash's version on the right, titled
  "Stash@{n}: <file>". A host shows it where it shows every diff (Orca: the center tab).
- **Commands** address a stash by its commit id (`stash.apply/pop/drop` `id`, `stash.clear` `expect`): `A.stashList()`
  (`A.stashes()`), `A.stashChanges()` (Git ▸ Stash Changes…, also under the workbench's Git ▸ Uncommitted Changes),
  `A.unstashChanges()`, `A.unstashAs(s)`, `A.stashApply/stashPop(s, { index, branch })`, `A.stashDrop(s)`,
  `A.stashClear()`, `A.restoreStashes(trash)`, `A.showStashes(id)` ("View saved changes…" / "View Git stashes" of the
  notices; Smart Checkout's kept stash and the autostash notices offer it). Drop and Clear notices offer Restore (the
  engine keeps them 14 days); IntelliJ's "This cannot be undone." is left out of the Clear question for that reason.
- Tests `test/e2e/stash.test.js`, `test/hosts/orca-stash.test.js`.

## 12. Branches, remote, merge, rebase and conflicts

- **Branch commands** (`actions-branches.js`, all through `A.run`, each returns a Promise of the result or null):
  `checkout(name, { smart, force, overwriteLocal, ignoreOtherWorktrees })` (would-overwrite → `Git.dialogs.problem`
  "Git Checkout Problem" Smart / Force / Don't; `local_branch_exists` → Drop Local Commits / Rebase onto Remote;
  `checked_out_elsewhere` → "Worktree Conflict" Checkout Anyway; force's trash → "Geri getir"; smart's unstash
  conflicts → Conflicts dialog) · `createBranch(name, from, { checkout, overwrite, onProblem })` · `doRenameBranch(from,
  to, { unsetUpstream, onProblem })` · `deleteBranch(name)` (local: "Deleted Branch: x" with Restore / View Commits /
  Delete Tracked Branch; remote: asks, optionally the tracking local branch too) · `toggleFavorite` · `doNewTag(name, at,
  { message, force, onProblem })` · `deleteTag` (Restore) · `pushTag(name)` (`tag.push`) · `merge(source, { noFf, ffOnly,
  squash, noCommit, message, noVerify, allowUnrelatedHistories, smart })` · `rebaseOnto(target, { branch, upstream,
  rebaseMerges, keepEmpty, root, updateRefs, autosquash, allowPushed })` · `checkoutAndRebase(branch)` ·
  `pullInto(remoteBranch, 'merge'|'rebase')`. `A.blockedReason(reason)` shows "Cannot checkout because of unmerged files".
- **Remote** (`actions-remote.js`): `fetch(remote?)` · `updateProject()` (prefs `update.method` = Don't show again) ·
  `update(branch?, method?, { onDone, onConflicts })` (another branch than the current one: `branch.update`, a
  fast-forward) · `push(branch?)` (dialog) · `pushNow(branch, { force, target, remote, tags })` · `pushRejected(branch,
  res)` (prefs `push.updateMethod` = "Remember the update method choice"). Git's own failure text (stderr) is shown under
  IntelliJ's title: `A.failAs(title)` as the `onError` of `A.run`.
- **The ongoing operation** (`actions-op.js`): `opLabels()` (widget text, », ✕, Skip) · `opKey()` · `opSides()` (which
  stage each column shows: a rebase is shown reversed, "Yours" = stage 3 = the commit being applied) · `rebaseNames()` ·
  `settle(res, { done, context, operation, from })`: every `result` of merge / rebase / update / rebase.apply lands here —
  `conflicts` opens the Conflicts dialog once the snapshot lists them, `stopped` shows
  "Rebase stopped for editing" (Continue / Abort), success runs `done` (now, or after the operation was continued) ·
  `resolveConflicts(done?)` · `continueOp()` (`op.continue`; conflicts again → the dialog again) · `abortOp()` (asks "Abort
  rebase in <repo>?", then `op.abort`, "Geri getir" from its trash) · `skipCommit()` · `acceptSide(paths, 'yours'|'theirs')`
  · `resolveText(path, text, { encoding, bom })` · `unresolve(path)` · `resolvedPaths()` (the "Resolved" group of this
  step) · `conflictContext({ kind: 'unstash'|'merge', left, right })` (conflicts without an operation: what caused them) ·
  `rebaseInteractive({ base | onto, upstream, branch, entries, head })` · `confirmPublished(again)` (Rebasing Published
  Commit → Rebase Anyway = `allowPushed`).
- **Conflicts** (`Git.conflicts()` = the snapshot's `conflicts`, with or without an operation): `Git.dialogs.conflicts({
  onClose(finished) })`; `Git.mergeTool.open(path, { onClose })`, `.load(path)` (`conflict.read`, one session per file
  and step), `.progress(path)`, `.canOpen(conflict)` (text on both sides), `.autoResolve(path)`, `.forget(path)`. The merge
  itself is `Git.mergeCore` (DOM-free: `create`, `accept`, `ignore`, `applySafe`, `applyMagic`, `counts`, `text`).
- **Dialogs**: `Git.dialogs.newBranch({ from })`, `renameBranch`, `newTag`, `checkoutRevision`, `updateProject`,
  `pushRejected(branch, { target, onUpdate })`, `push(branch)` (`branches-push.js`), `merge({ source })`, `rebase({
  target, interactive })`, `interactiveRebase(fromId)` / `interactiveRebase(null, { onto, upstream, branch })`
  (`rebase.plan` / `rebase.planOnto`; the plan is `Git.rebasePlanModel`), `problem({ op, files, untracked, force, onSmart,
  onForce })`, `worktreeConflict`, `localBranchExists`, `notFullyMerged`.
- **Popup** (`branches.js` + `branches-tree.js`): `Git.branches.open(anchor)`, `.close()`, `.menuFor(name)` (the
  submenus of IntelliJ's §5: current / local / remote branch / tag); prefs `branches.group|recent|tags`.
- **Engine additions** (`core/ops/extra-branches.js`, `core/read/extra-branches.js`, PROTOCOL): `rebase.planOnto`,
  `rebase.applyOnto`, `branch.update`, `tag.push`.
- **Tests**: `test/ui/merge-core|merge-plan|branches-tree.test.js`; e2e `branches-*`, `remote-*`, `merge-*`, `rebase-*`,
  `conflicts-*.test.js` on the repositories of `test/e2e/b3-fixtures.js`; page helpers `T.dialog(title)`,
  `T.pressBtn(dialog, idOrLabel)`, `T.noDialog`, `T.dialogs()`, `T.branchAction(name, label)`, `T.branchMenu(name)`,
  `T.waitRepo(fn)`.
- **Second pass (area C review + QA, these lines supersede the ones above where they differ):**
  - A ref's kind comes from where it is listed, never from its name: `Git.branches.menuFor(name, kind)` (`branches-menu.js`;
    `kind` 'local'|'remote'|'tag', rows carry `kind` from `branches-tree.js`; without it the name is resolved like typed
    text). qa-3: every action of `menuFor`, the Log's branches pane and the commit menu's Checkout ▸ / Branch / Tag
    submenus get the pair `A.ref(kind, name)` — `checkout(ref)`, `merge(ref, { into })`, `rebaseOnto(ref, { branch,
    upstream, into })`, `checkoutAndRebase(ref)`, `pullInto(ref)`, `newBranch(ref, label)`, `deleteBranch(ref)`,
    `toggleFavorite(ref)`, `update(ref)`, `push(ref)`, `renameBranch(ref)`, `deleteTag(ref)`, `pushTag(ref)`,
    `compareWithCurrent(ref)`, `showDiffWithWorkingTree(ref)` — and A.wire alone makes the full ref (§5 "Refs are
    pairs"; `test/e2e/branches-fullrefs.test.js`, `branches-refpairs.test.js`).
  - Popup: Checkout and Update (`A.checkoutAndUpdate`: `branch.update` then checkout, update when diverged), keys Space /
    ⌘C / F2 / ⌘F, gear menu (Show Actions in Search Results, Restore Popup Size; prefs `branches.actions`, `branches.size`),
    a resizable popup (corner grip), New Branch… = "Create Branch from <current>", the first ongoing action selected, a
    revert offers only Abort Revert.
  - Dialogs: `Git.dialogs.tag({ commit })` (Git ▸ New Tag…: Git Root, Tag Name, Force, Commit + Validate, Message, Create
    Tag; `A.tag()`), Update Project ▸ Reset to the Remote Branch (`A.resetToRemote`), Push Rejected with the remote's
    commit count, Force Push (`o.onForce`; prohibited on main/master) and the current checkbox text, Push Commits' files
    toolbar and divergence banner + Update project…, (?) help buttons (`Git.mergeUi.help(url, id)`, `U.HELP`), the
    --onto help balloon. Show Diff from a modal dialog opens over it: `Git.mergeUi.diffOver(commitId, path)`,
    `Git.mergeUi.textsOver(title, path, { left, right })` (Git.diffTab mounted in a dialog, kind `texts`, id `diff:over`).
  - Rebase: every Rebase dialog option reaches git with and without --interactive (`A.REBASE_FLAGS`; `rebase.planOnto`
    autosquash / root, `rebase.applyOnto` flags, `rebase` noAutosquash), options in GitRebaseOption's order, the 'noop'
    Yes/No question; Rebasing Commits: virtual rows (`Git.vlist`; the row being reworded grows to hold its editor and
    pushes the rows below down: the list's one `tall` row), details
    loaded when needed, Show Diff toolbar, Reset stays while rewording, the keyboard on the dialog's sink.
  - Merge tool: ⇄▾ Compare Contents and Show Details (`merge-tool-extra.js`), binary and one-sided conflicts open side by
    side with Accept Left / Right (`Git.mergeTool.openWhole`; `canOpen` is true for every kind but both-deleted), CRLF
    lines keep their CR when the Result is typed into, focus stays in an editable element after every action.
  - Notifications: "Rebase stopped for editing" is an information balloon (title + Continue / Abort), `<b>Deleted
    Branch:</b> x`, `<b>Deleted Tag:</b> x` + Delete on Remote (`tag.remotes`, `tag.deleteRemote`), abort asks
    "Abort merge?" / "Abort cherry-pick?" / "Abort revert?" / "Abort rebase in <repo>?". Rollback of a new branch refuses
    once the branch moved. `tag.push` without a remote goes where `push` would.
  - Remaining deviations: help (?) opens IntelliJ's web help; the merge tool's Show Details is a popup list (IntelliJ: a
    panel under the side); `amend!` commits are planned as a fixup with the amend message on the target; a range with
    merge commits cannot be edited in Rebasing Commits (IntelliJ falls back to a plain text todo editor): it is refused
    with IntelliJ's "Cannot Start Rebase" / "Commit {0} has {1} parents". Favorites are keyed by kind (qa-3): a local
    `origin/x` and the remote `origin/x` have stars of their own; a remote star saved before, by its short name, is not
    shown any more. An ignored file standing where an incoming tracked file goes stops checkout, merge and update with
    Would-overwrite (listed as ignored in "Untracked Files Prevent …"; Force Checkout saves it to the trash first),
    where git and IntelliJ overwrite ignored files silently (ARCHITECTURE §3.5: discarded content is saved first).
  - Integration pass: `settle` no longer treats `autostash: 'conflicts'` as conflicts (the operation is done: its notice,
    then the shared `A.autostashConflicts`); a cherry-pick / revert stopped before its next commit shows
    `A.sequenceStopped`, the popup offers Continue and Skip Commit for it (a waiting revert too); Continue at an edit stop
    with changes not committed is refused as a sentence (`uncommitted_changes`: "You have uncommitted changes. Commit them
    (Amend changes the stopped commit) or roll them back, then continue the rebase.", Commit…).

## 13. Log and history

- **Commands** (`actions-history.js`, all through `A.run`, deciding by `result` and `data.reason`; each returns a
  Promise of the result or null): `cherryPick(ids)`, `revert(ids)` (success / nothing / skipped / Would-overwrite /
  conflicts → `A.resolveConflicts(done)` once the snapshot shows the operation), `undoCommit(id)` (its message goes out
  as `commit-message`), `reset(id)` → `Git.dialogs.reset` → `doReset(id, mode)` ("Restore" from `trash`),
  `editMessage(id)` (protected-branch check and "Editing Initial Commit" before the dialog) → `doEditMessage`,
  `drop(ids)` → `Git.dialogs.dropCommits` → `doDrop` (reword and drop offer Undo = `reset --keep` back while HEAD has not
  moved), `interactiveRebase(id)` → `Git.dialogs.interactiveRebase` (branches area) and `applyRebasePlan(base, entries,
  { head, allowPushed })` (asks "Rebase Anyway" on `pushed_to_protected`), `applySelectedChanges(commitId, paths)`,
  `getFromRevision(rev, paths)`, `restoreTrash(trash)`, `showHistory(path, { rev })`, `showFileAt(path, rev)` (the
  file view's `rev` mode), `annotate(path, { rev })`. Refusal texts: `A.reasonText(reason, data, what)` (IntelliJ's).
- **Rules of the commit menu**: `Git.logUI.menuState(ids, facts)` (`log-logic.js`, DOM-free) → `{ key: { on, why } }`
  for copy, cherryPick, checkout, compareLocal, reset, revert, undo, reword, drop, rebase, newBranch, newTag; `why` is
  IntelliJ's reason as `[english, …args]`. `Git.logUI.menuFacts()` reads the repository. Pushed-to-protected is
  decided when the command runs (engine refusal; reword/drop check `commit.containing` first, as IntelliJ does).
- **Log API**: `Git.log.reveal(idOrRef)`, `.select(ids)`, `.selected()`, `.setBranchFilter(names)` (a name may be a
  two-dot range `a..b`), `.refresh()`, `.stats()`. The selection stays on commits that still exist after the list
  changed (`L.keepSelection`); a reworded commit takes the selection along. `R.log.truncated` shows "Showing the first
  100 000 commits" under the table; an arrow to a commit past the cap says so instead of jumping.
- **Changed Files**: several commits are zipped (`L.zipChanges`: one change per path from before the oldest to after
  the newest commit; such an entry's diff is a `texts` tab `diff:combined`). `L.entryMenu`, `L.showEntryDiff`,
  `L.compareWithLocal`, `L.fileTree` are shared with the compare tab.
- **Tabs**: `Git.views.history.mount(el, { path, rev })` (`log.fileHistory`; each revision shows its path when the file
  was renamed; preview diff, Get, Annotate, Open Repository Version), `Git.views.compare.mount(el, { a, b })`
  (`compare.branches`), `Git.views.branchDiff.mount(el, { branch })` (`compare.files` against the work tree, Get from
  Branch). Their options persist in `Git.host.prefs` `tabs.opts`.
- **Engine addition**: `changes.getFromRevision` (`core/ops/extra-log.js`, PROTOCOL.md).
- **Tests**: `test/ui/log-logic.test.js`; e2e `log-pick|log-edit|log-reword|log-menu|log-view|log-files|log-big-history`,
  `history-file|history-compare.test.js` on `test/e2e/log-fixtures.js` (`log-run.js`: `run`, `START`, `SPY`); page
  helpers `T.logRow(id)`, `T.logMenu(id, { keep })`, `T.menuItem(label)`, `T.closeMenu()`, `T.waitHead({ is | not })`.

### 13.1 Second pass (comparison B): what was added

- **Graph Options** (`#gl-graph`, `vcslog/intelliSort`, after Paths): Sort ▸ By Commit Date / Topologically, Options ▸
  First Parent / No Merges (prefs `log.opts.sort|firstParent|noMerges`), Collapse / Expand Linear Branches. A non-default
  choice asks the engine's walk `log.graphOrder` (`core/read/extra-log.js`; the view waits for it like the text filter);
  First Parent draws only first-parent edges, No Merges hides merges with dotted edges over them (`filteredParents`).
  Collapse is `Git.graph.collapse(order, { parents, refs, dotted, collapsed(key) })` (`graph.js`, DOM-free): a chain of
  commits with one parent, one child and no ref leaves the table, its child gets a dotted edge to the chain's last parent.
  State `L.collapse` (`setCollapsed(all)`, `toggleChain(key)`); a click on a dotted edge opens that chain, a click on an
  edge of a chain folds it (`Git.graphPaint.edgeAt(graph, row, x, y, h)` over `graph.withEnds(i)`). Go To / reveal opens
  the chain that hides a commit.
- **View Options** (the eye; IntelliJ's source name): Commit Timestamp (`log.opts.commitDate`: the Date column shows
  `commitTime`), References on the Left (`labelsLeft`).
- **Text filter**: applied on Enter or when the field loses focus; the ▾ by the magnifier (`#gl-text-history`) lists the
  last 20 patterns (prefs `log.textHistory`). Branch ▸ Select… and Paths ▸ Select… take several values (new lines or
  `|`, ⌘↵); Paths opens Select in Tree… / Select… / the last five path sets (prefs `log.recentPaths`).
- **Go To on a filtered Log**: `Git.log.reveal` no longer drops filters silently: IntelliJ's balloon "Commit 'x' doesn't
  match the filters" with View and reset filters.
- **Commit menu** (D §6.2.2 order): Show Repository at Revision (`A.showRepositoryAt` → `Git.views.repoAt`,
  `files.listAt`), Compare Versions (two commits; `A.compareVersions(a, b)` → `Git.views.versions`, "Changes Between a
  and b"), Fixup… / Squash Into… (`A.fixupInto(id, mode)`: Commit Changes dialog → `A.doFixup` → `commit.fixup`),
  Squash Commits… (`A.squashCommits(ids)`: "Squashed Commit Message" → `rebase.plan` + `rebase.apply`, Undo; the
  message is the commits' whole messages in history order: left unedited, the others go as `squash` and git joins their
  own %B messages; edited, the typed text with `fixup`s), Push All up
  to Here… (`A.pushUpTo` → `push.upTo`), Add Commits to Remote Branch… / Push Selected Commits… (`A.pushCommitsTo(ids,
  selected)` → `push.commits`, in-memory pick). Dialogs and tabs: `log-actions.js`, `log-revisions.js`. Rules in
  `L.menuState` (keys `showRepo`, `compareVersions`, `fixup`, `squashInto`, `squash`, `pushUpTo`, `addToRemote`,
  `pushSelected`; facts `localChanges`, `hasRemotes`, `detached`).
- **Disabled reasons**: `menu.js` items take `why` (a dim second line + tooltip on a disabled row); the commit menu and
  File History menu pass `L.menuState`'s reason.
- **Changed Files**: toolbar Show Diff, Revert Selected Changes (`A.revertSelectedChanges` → `changes.revertFromCommit`,
  Restore), History Up to Here, View Options (Group By ▸ Directory; Layout ▸ Show Details, Show Diff Preview, Diff
  Preview Location ▸ Bottom / Right; prefs `log.opts.details|preview|previewAt`); menu in IntelliJ's order with Compare
  Before with Local, Revert Selected Changes, Get, Show Changes to Parents (merge, a toggle). The diff preview is
  `L.diffPreview()` (`log-preview.js`, shared with File History) with the viewer choice Side-by-side / Unified (prefs
  `tabs.opts.viewer`). Commit Details has no Parent(s) line (IntelliJ has none).
- **File History**: Show All Affected Files (toolbar `#glt-affected`, ⌃⌘A, menu; "Paths Affected by Commit {0}"),
  View Options ▸ Show Commit Timestamp, Branch chip always with ×, menu in IntelliJ's order (Cherry-Pick, Get, Show File
  at Revision, …, Show Diff in a New Tab or Window, Fixup…, Squash Into…, New Tag…).
- **Compare tabs**: Compare with Current is one list ("Commits that exist in a but don't exist in b", Swap Branches),
  tab "Compare: a and b"; Show Diff with Working Tree is "Changes Between x and Current Working Tree".
- **Console**: the engine's reads inside an operation (rev-parse, for-each-ref, cat-file, ls-files, status, …) are left
  out with their output (`Git.logUI.consoleShown`, as IntelliJ's silent handlers); toolbar Use Soft Wraps, Scroll to
  the end, Clear All; the tab appears once a command ran and closing it drops the output (`workbench.js`).
- **Branches pane**: a tag's menu is the branch widget's tag menu (Checkout, Show Diff with Working Tree, Merge, Push to
  origin, Delete); empty groups (Remote without remote branches) are not shown.
- **Engine** (PROTOCOL): `log.graphOrder`, `files.listAt` (`core/read/extra-log.js`), `changes.revertFromCommit`,
  `commit.fixup`, `push.upTo`, `push.commits` (`core/ops/extra-log.js`). Tests `test/core/extra-log-graph|ops.test.js`,
  `test/ui/graph-collapse.test.js`, `test/ui/log-graph-options.test.js`, e2e `log-graph|log-squash|log-push.test.js`.

### 13.2 Remaining deviations from IntelliJ (Log area)

- No extra Log tabs (`+`, ⊞+, the tab list ▾), no Not Cherry-Picked Commits highlighter, no Root Names (one root), no
  indexing button, no Open on GitHub, no Create Patch, Extract Selected Changes to a Separate Commit, Drop Selected
  Changes (out of scope by decision).
- Sort offers By Commit Date and Topologically; IntelliJ's internal "Linearize Merges" is not offered. Topologically is
  git's `--topo-order` (incoming commits directly below the merge, as IntelliJ's Bek sort puts them); the exact lane order
  of IntelliJ's Bek sort inside long criss-cross histories may differ.
- Collapse Linear Branches keeps commits with a ref (branch, tag, HEAD) visible; a chain needs at least one commit.
- Fixup… / Squash Into… commit and rebase at once from a small "Commit Changes" dialog (IntelliJ goes through its
  commit window and "Commit and Rebase…", which then shows the Rebasing Commits dialog); the files offered are the ones
  ticked in the Commit view, else every tracked change.
- Push All up to Here… / Push Selected Commits… / Add Commits to Remote Branch… use a small dialog of this area (area
  C's Push dialog takes no upper bound); no force, no tags there.
- Show Repository at Revision opens a tab with the revision's file tree, not a Repositories tool window; the tab title
  "<repo> at <hash>" is not from IntelliJ's bundle.
- Undo Commit… keeps its "…" although no Select Target Changelist dialog follows (changelists are out of scope); Revert
  Commit commits at once when there is no conflict (current IDE behavior).
- The long-edge tooltip is a plain SVG title: the subject is not bold.
- The Branches pane's tag rows use the ref-label icon (IntelliJ's tree icon for tags is not shown in the spec).
- Commit Details reflow a hard-wrapped body (`L.reflowBody`, all arrangements): IntelliJ shows the lines as written.
  Copying from the details gives the reflowed text.
- In the narrow arrangement Commit Details show the who line (hash, author, date) and the ref labels right under the
  subject, before the body (CSS `order`; the DOM keeps IntelliJ's order). IntelliJ has no narrow arrangement.

### 13.3 The three arrangements (`log-layout.js`, owner's decision, not IntelliJ)

The Log root's size picks the arrangement (`L.arrangement(w, h, prev)` in `log-logic.js`; recomputed on resize, a
size within 6 px of a border keeps the current one): **narrow** below 520 px wide; **medium** 520–599 px always and
600–959 px when the root is at least 520 px tall (a tall side panel); **wide** otherwise (≥ 960 px, or 600–959 px in a
short tool window such as the workbench's Log tab). Root classes `narrow` / `medium` / none.

- **Wide** is IntelliJ's three columns (Branches | Commits | Changed Files over Commit Details); its splitter keys
  `log-branches`, `log-right`, `log-files` and `opts.branches` (show the pane or the strip) are its own. The side
  panes' widths (`L.wideSizes`, `log-layout.js`) are computed at every layout from what each pane wants (its dragged
  size, else the right pane 26 % of the root clamped to 300–460 px and the branches pane 231 px) and the room there is
  now, so a pane that had to give way grows back. Minimums: right 280 px from a 1100 px root, 240 px from 960, 170 px
  below; branches 150 px (a smaller stored size is raised). When they do not fit, the commits keep half the root (at
  least 260 px): the branches pane gives way first, then the right one. Test `test/e2e/log-wide.test.js`.
- **Medium**: the commits (Author / Date as in wide) over a bottom pane: Changed Files at the left, Commit Details at
  the right (1 : 1.25), a hairline splitter between them (`size.log-files-medium`). The splitter over the bottom pane
  sets its height (`size.log-bottom-medium`, default 38 % of the root; the bottom pane keeps 110 px, the commits 150 px).
- **Narrow**: one-line rows without the Author column; the Date column becomes a compact date at the right end
  (`.gl-when`, `L.compactDate`: today `HH:MM`, yesterday "Dün HH:MM", this year `DD.MM HH:MM`, before `DD.MM.YYYY`;
  English `M/D HH:MM`, `M/D/YY`; only with View Options ▸ Date). The bottom pane (default 42 %) shows Commit Details
  first and Changed Files under them, with a splitter between the two (`size.log-details-narrow`): until it is dragged
  the details take their content's height (at most 58 %, scrolling inside); dragged, they keep that height (at least
  60 px; the files keep 90 px; clamped when the pane shrinks). The details read subject, who line, ref labels, body,
  containing branches.
- **Narrow, the pane's height**: automatic until a line is dragged. Automatic: the content's height while the details
  and the whole list fit in the 42 % plus about a row (`.gl-fit`), else the 42 % (a list never scrolls by a few
  pixels). Dragged (`size.log-bottom-narrow-fixed`): exactly the dragged height, whatever the content (sized by its
  content, the line stood still when dragged up and jumped after a dead zone when dragged down). Moving the details |
  files line also fixes the pane at the height it has then (else the pane followed the details' height: the line
  stayed and the pane's top moved). A double click on a line gives that line its automatic size back (also medium's
  two lines: their defaults). The older key `size.log-bottom-narrow` held a share, not a shown height, and is not read.
- **First paint** (Orca re-creates a panel's frame on every switch of its sidebar tab): until the root has had a size it
  carries `gl-unsized` (`visibility: hidden`) and no arrangement is guessed; the Log's ResizeObserver watches the root
  and applies a new arrangement in the same callback (`layout.pending()`), before that frame is painted.
- **Remembered place** (`log-place.js`): per repository root, the selection (with anchor and lead) and the table's
  scroll offset in `localStorage` with the time written (forgotten after 12 hours; memory when it throws; Orca gives a
  re-created panel frame an empty `sessionStorage`). A fresh mount restores them when those commits are still
  in the log, without taking the focus; a selection or a reveal that is already there wins; gone commits restore
  nothing. Nothing is written before the restore ran.
- **Waits**: "Loading commits…" (the status line) and "In branches: loading…" show only once a wait has lasted 400 ms;
  the In branches line takes its place from the start (the details do not jump).
- **Branches drawer** (narrow and medium): the toolbar's first button `#gl-branches-open` (branch icon + "Branches";
  `fit()` drops the label before it squeezes the search field) opens the real Branches pane over the Log from the left
  (`min(300px, 86%)`, a scrim over the rest, 160 ms slide, none with reduced motion). It closes on the scrim, Escape,
  the pane's hide button (which then leaves `opts.branches` alone) and whenever the pane filters or reveals in the Log;
  it starts closed and closes when the arrangement changes. Opening focuses the pane's search field, closing returns
  the focus to the button; closed, the pane is `inert` and hidden.
- A diff preview at the right goes under the bottom pane while the panes are stacked.
- Tests: `test/ui/log-layout.test.js` (arrangement, compact date, reflow), e2e `test/e2e/log-layout.test.js` and
  `test/e2e/log-place.test.js` (first visible frame, splitters dragged, place across a reload, the 400 ms waits),
  `test/e2e/log-narrow-fit.test.js` (the automatic height), `test/e2e/log-narrow-drag.test.js` (the lines follow the
  pointer, a click changes nothing, a double click resets).
