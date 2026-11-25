# Optional SillyTavern document inbox

This is a **SillyTavern server plugin**, not a browser extension. No npm install
or custom backend service is required. Linux and Android Termux are supported;
secure descriptor traversal requires Linux `/proc/self/fd` and `O_NOFOLLOW`.
Windows is not supported by this plugin.

1. Copy this directory to `SillyTavern/plugins/chat-assistant-inbox/` (the
   `index.js` and `package.json` must be directly inside that folder).
2. Set `enableServerPlugins: true` in SillyTavern's `config.yaml` and restart ST.
3. Open Chat Assistant → Document Library → **Import without Android file picker**
   → **Browse inbox**. This creates the logged-in user's inbox, mode 0700.
4. Copy TXT/Markdown files or folders into
   `<SillyTavern data root>/<user handle>/chat-assistant-inbox/` using a shell,
   desktop file manager, SFTP or Termux `cp`. For a standard single-user install
   this is usually `SillyTavern/data/default-user/chat-assistant-inbox/`.
5. Browse subfolders and import one document, or enter a relative folder and
   click **Import folder recursively**. Imported documents are not automatically
   selected; select them separately in the current chat.

No Android file picker is used. Directory imports load one document at a time
(maximum 10 MiB per file) and list 50 entries per page. The existing Library's
200-document limit applies. Successful imports remain if a later file fails;
failures do not replace existing documents. Close the dialog to stop after the
current save. Reimporting creates another document; it does not overwrite by
filename. Keep the inbox unchanged during a directory scan, since native
filesystem listing order and offsets are not a transactional snapshot.

## Optional HTTPS imports

Disabled unless the server administrator sets an exact-host allowlist before
starting SillyTavern, for example:

```sh
export CHAT_ASSISTANT_INBOX_URL_HOSTS=documents.example.org,raw.githubusercontent.com
node server.js
```

Use **Import URL** with a direct `.txt` or `.md` HTTPS URL. The endpoint must
return `text/plain` or `text/markdown`, valid UTF-8, HTTP 200, and at most 10 MiB.
Authentication URLs, custom ports, redirects and IP-literal hosts are rejected.
DNS results must all be public IPv4 addresses; the chosen address is pinned for
the connection while HTTPS still validates the original hostname. IPv6-only
hosts are intentionally unsupported. No browser cookies or API credentials are
forwarded. A 15-second deadline bounds downloads. Grant only hosts you trust to
serve documents; allowlisting a hostname is an administrator decision.

## Security boundary

Routes live under `/api/plugins/chat-assistant-inbox/` behind SillyTavern's
normal authenticated/CSRF-protected middleware, and additionally require the
server-supplied user identity and data directory. Never expose an alternative
unauthenticated router. In single-user ST, its default authenticated user is the
security boundary; retain normal ST access controls for LAN/public hosting.

The client cannot choose an absolute root. All operations stay inside that
user's fixed inbox. Dot paths, hidden components, traversal, backslashes, NUL,
symlink components, special files and hard-linked files are rejected. Directory
descriptors pin parent paths against symlink substitution. The plugin never
writes Library metadata or document bodies, and has no delete/move endpoint.
Browser import passes one verified text through the existing immutable body,
catalog verification and per-chat selection mechanisms.

The server operator and anyone who can modify SillyTavern's installation/data
roots remain trusted. Server plugins execute with ST's process privileges.
Review this code before enabling plugins. Plugin updates require recopying this
folder and restarting ST; updating the browser extension alone does not update
an installed server plugin.

Run `node server-inbox/test.mjs` from the extension repository for the isolated
security tests; `node load_test.mjs` also includes them.
