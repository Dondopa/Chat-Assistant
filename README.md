# Chat Assistant (SillyTavern extension)

A floating AI panel inside SillyTavern where you talk to a **second "assistant" model** that can surgically edit your story — chat messages, memory, and worldbook — to keep a long roleplay consistent, and that also runs two autonomous showrunner systems (a hidden **Director** and a standing **Editor**) to keep the storytelling sharp.

> Formerly "Continuity Copilot." Inspired by the concept of **ST-Copilot** (MIT, github.com/Supker/St-Copilot), but the code here is original and the scope has grown far past a chat manager: this is a continuity auditor, co-writer, and editor in one.

## v2.87.0 — Author’s Note approval bridge

Ask Chat Assistant to read, review, replace, append to, clear, or compose the
current chat’s Author’s Note. For example: “Update my Author’s Note for the
current scene using the location, present NPCs and unresolved danger. Keep it
under 400 tokens.” Read is non-destructive. Every mutation opens a separate
**Current / Proposed** review dialog with **Apply / Cancel**; append includes
the resulting full note, and clear requires **Clear Author’s Note**. Escape
cancels. Model output never writes the note, and there is no background updater.

The structured contract is one `<authorsnote>` JSON object with `operation`:
`READ`, `PROPOSE_REPLACE`, `PROPOSE_APPEND`, or `PROPOSE_CLEAR`. Replace/append
require a nonempty string `content`; clear/read take no content. Invalid,
incomplete, mixed or multiple operations fail without writing. Raw control
blocks are hidden from the normal response. Proposals are transient and cannot
be replayed after Cancel, Apply, chat change or reload.

The bridge reads SillyTavern’s live `chatMetadata.note_prompt` (with the native
`extensionSettings.note.default` fallback). It keeps no independent note store.
After approval it calls `updateChatMetadata({note_prompt: text}, false)`, awaits
`saveMetadata()`, then uses `reloadCurrentChat()` to refresh SillyTavern’s own
Author’s Note controls and prompt state and verifies the reloaded value. This
also supports a genuinely empty note. It does not scrape/edit ST textareas,
simulate clicks or interpolate note contents into slash commands. Depth, role,
interval, position and other metadata are preserved. The existing generic
`memedits` path for `note_prompt` is retired so it cannot bypass this review and
synchronization route; other memory and Director edit paths remain available.

The proposal captures the current chat identity, metadata instance and note
value. Any changed base note or active chat blocks Apply and requires a fresh
proposal. Save/refresh failures trigger a guarded rollback of only our text;
newer external edits and other chats are never overwritten by recovery. Native
save errors can be swallowed by SillyTavern, so the reload/read-back check is
required before reporting success. If recovery cannot be verified, the bridge
reports that uncertainty and asks the user to inspect the note; it never claims
that an unverified write succeeded. Switching chat after a confirmed save can
leave that approved change saved in the original chat; the destination chat is
not refreshed or modified. Save/reload APIs and a stable chat ID are required
for writes; unsupported hosts fail without changing text.

Author’s Note is short, intentional storyteller guidance. World Info remains
static lore; Campaign Ledger remains accepted playthrough memory. Composition
reuses current/recent RP, bounded accepted/source-valid campaign retrieval and
the existing selective lore tools. It does not inject pending records, search
or send entire lorebooks, copy the whole ledger, or write World Info. Current
lore-discovery settings still control its normal selective research behavior.
The bridge neither proves a generated note’s semantic accuracy nor guarantees
a model’s requested token budget: the proposal remains for human review.

Regression tests cover read/empty/unavailable state, all three proposal/approval
and cancellation paths, stale notes/chats, failure recovery, native read-back,
metadata preservation, parser failures, generic-write bypass prevention and a
READ → existing lore fetch → proposal workflow with accepted-only campaign
context. Browser tests exercise the confirmation UI at 360, 412 and 1280 px,
alongside Campaign Ledger review and mobile layout checks. Campaign Ledger,
lore algorithms, mobile fixes and Director/session behavior were not redesigned.

Integration was checked against SillyTavern’s
[Author’s Note state](https://github.com/SillyTavern/SillyTavern/blob/staging/public/scripts/authors-note.js)
and [extension context APIs](https://github.com/SillyTavern/SillyTavern/blob/staging/public/scripts/st-context.js).

## v2.86.0 — Message-anchored Campaign Ledger and human review

Campaign Audit now extracts **pending candidates anchored to an actual RP
message**. The model returns `sourceMessageIndex`, a supported `type`, `subject`
and `fact`. Optional `speaker`, `related` and `evidence` (`narration`, `dialogue`,
`thought`) classify the candidate; the prompt requests evidence classification
for mixed messages and dialogue-only entity references. No model quotation,
span ID, range, offset or evidence-character limit is required. Incidental old
quote/range fields are ignored, not used as an alternate evidence path.

Code validates the required fields and that the source index belongs to the
eligible audited RP batch. System/hidden messages and explicitly labelled
OOC/analysis are excluded; assistant session history, Director plans and
lorebook entries are never audit inputs. The captured chat and all source
fingerprints are rechecked before committing. Malformed responses or invalid
source references still reject the entire batch with no cursor movement.
Whole-message input continues through `fullTextOf()` with COMPLETE labels and
the existing 50-message/24,000-character request budget. That request budget is
not a substring evidence cap; an oversized single input fails explicitly rather
than being silently clipped.

All new records are **pending**, and pending/rejected/stale records cannot enter
Campaign Ledger retrieval. Narrated-event candidates show **UNREVIEWED RP**,
not Campaign Canon, until accepted. Review cards show type, subject, fact/claim,
source index and speaker, status and optional lore candidates. **Show source RP
message** opens the entire current, fingerprint-matching RP text as plain text.
It is not a model-generated quote. If the source has changed or the chat has
switched, the viewer reports that instead of presenting replacement text as the
original evidence. Reject remains available; stale sources cannot be accepted.

The extractor classifies mixed messages semantically and humans verify that
classification. Declared dialogue becomes NPC_CLAIM (or a NEW_ENTITY dialogue
reference); declared thoughts become UNRESOLVED_CLAIM. An entirely
backtick-delimited source is also kept subjective even if the model mislabels
it. Unrelated dialogue/thought in a mixed message no longer invalidates a
narrated-event candidate. This is not deterministic proof of semantic truth:
a wrongly classified mixed-message candidate can reach review and should be
rejected. Accepting NPC claims or thoughts never upgrades their contents to
objective truth. Acceptance approves playthrough memory, not Worldbook Canon.

Accepted records use the same bounded selective retrieval (12 records/6,000
characters). The whole source message is available for human inspection but
is not automatically injected into future model context. Editing, replacing,
hiding, deleting or reordering a source so its fingerprint no longer matches
makes its records ineligible. Existing records need no migration: their legacy
quote/offset fields are inert, and the same message fingerprint is the only
source anchor. No second span validator remains active.

Removed Campaign Audit's span segmentation, span/range resolver, length-choice
metadata and offset-based provenance scanning. Tests now cover narrated events,
NPC claims, thoughts, long mixed RP/status messages, atomic failures, source
staleness, chat isolation, review filtering and bounded retrieval. Real-browser
panel tests exercise source inspection, safe text rendering, Accept and stale
sources at desktop and mobile sizes. Selective lore discovery, wisearch/wifetch,
optional entity-name lore checks, mobile opening/layout, the ledger visibility
fix, Director/session features and World Info write behavior are unchanged.

## v2.85.5 — Measured Campaign Audit evidence choices

Span labels now include their exact character length and `validEnds`: permitted
end IDs with the total inclusive range length for each choice. The extractor
chooses its start and an end from that start’s list; it no longer has to estimate
lengths. `validEnds=none` means that start has no permitted range. The existing
limits remain **at most four spans, at least eight characters after trimming
outer whitespace, and at most 1,200 original characters**. Counting uses UTF-16
code units, including Markdown, punctuation, spaces and newlines. A shared size
policy produces the choices and validates returned ranges. Labels count toward
the existing whole-message audit budget; source text is not clipped or omitted.

The prompt puts the hard limits first, explains why three 600-character spans
are invalid despite meeting the span-count limit, and requires checking every
record against the printed choices. These choices certify size, not that a
range supports the model’s interpretation; pending records still require review.

Diagnostics distinguish invalid structure from valid endpoints whose evidence
is too short or too long. The toast reports the measured size; safe console
metadata includes the category, size issue, source length, trimmed length and
limits. Invalid evidence still rejects the entire batch without cursor movement.

No automatic narrowing is performed. Finding a smaller permitted boundary is
deterministic, but deciding whether it preserves support for a natural-language
claim is not. Removing a tail could discard a qualification, dialogue or thought,
or leave a narration-only range that changes provenance. Neither the 1,200 cap
nor the evidence rules were relaxed. Range references, source fingerprints,
mobile behavior, ledger visibility and lore discovery are unchanged.

Regression fixtures reproduce valid same-message endpoints resolving below
eight or above 1,200 characters, including atomic candidate-2 failures. They
check exact boundary acceptance, metadata/validator agreement, whitespace and
Unicode counting, four-span limits, and refusal to narrow away claim/thought
tails. The unseen live model response is not claimed as an exact replay.

## v2.85.4 — Inclusive Campaign Audit evidence ranges

The model now supplies `sourceSpanRange: {"start":"M23:S2","end":"M23:S4"}`.
It identifies the two endpoints; extension code includes S2, S3 and S4 and
copies the exact continuous original slice. A single span uses the same ID
for both endpoints. This removes the v2.85.3 requirement that the model
correctly enumerate a consecutive array.

Both endpoints must exist in the candidate's cited, supplied RP message and
start must not follow end. The inclusive range may contain at most four spans
and must meet the unchanged 8–1,200 source-character limit. Missing, foreign,
reversed, nonexistent, malformed and oversized ranges reject the entire batch,
without saving records or moving its cursor. No sorting, deduplication,
endpoint repair, disjoint arrays or legacy quote fallback is performed.
Diagnostics identify the candidate, field and reason without printing RP text.

Provenance is checked against the resulting offsets in the original message,
including every intervening span: narration endpoints cannot hide dialogue or
thoughts between them. Persisted records still store the expanded span IDs,
exact quote and offsets; previous ledger records need no migration. Mobile
positioning, Campaign Ledger visibility and lore discovery are unchanged.

Regression tests cover the live failure class (endpoint selection that formerly
omitted an interior span), complete two-candidate audit success, same-endpoint
ranges, inclusive span/character limits and whole-batch rejection for invalid
candidate 2 ranges. The screenshot did not include the actual rejected array,
so the fixture reproduces that contract failure class rather than claiming to
replay the unseen response.

## v2.85.3 — Deterministic Campaign Audit evidence

Campaign audits now ask for `sourceSpanIds` such as `["M23:S2"]`, never a
recreated quote. Before extraction, code partitions each eligible RP message
into exact source spans at newlines, splitting long lines into at most 600
UTF-16 characters without splitting emoji surrogate pairs. IDs are temporary
addresses within that audited message snapshot. Complete messages still pass
through `fullTextOf()`; structural labels are inserted without removing or
normalizing any original characters. Labels count toward the existing 24,000
character batch budget; they are not part of the source evidence.

A candidate must reference 1–4 consecutive spans, in order, from its supplied
message. Their continuous original slice must contain 8–1,200 characters.
The extension copies that slice into the stored quote, with span IDs and exact
offsets. It never resolves a paraphrase, repairs an invented ID, or falls back
to a model-supplied quote. An incidental `quote` field is ignored. Missing,
foreign, duplicate, reversed, disjoint or oversized references reject the
**whole batch**, with record/field/reason diagnostics and no cursor advance.
Existing stored records remain valid under their original fingerprint and
literal-source checks; no migration or re-audit is required.

Provenance is checked at those offsets in the original entire RP message.
Dialogue and backtick thoughts cannot become objective canon by omitting their
punctuation from the model output. A span mixing narration with dialogue/thought
is conservatively treated as a claim. Source fingerprints still reject edits,
swipes or reorders during extraction. Structural anchoring proves where evidence
came from, not that the model interpreted it correctly: records remain pending
human review. Analysis/OOC exclusion and all other field checks remain intact.

Regression coverage reproduces the v2.85.2 failure class: a correct Vael candidate
with a Markdown/typography-normalized quote succeeds only with a resolvable span
ID and stores the untouched original RP. The original rejected model payload was
not available. Tests also cover ambiguous repeated text, wrong-message IDs,
range limits, complete source preservation and atomic failure. Campaign Ledger
visibility, mobile positioning and lore discovery are unchanged.

## v2.85.2 — Campaign Audit contract and safe diagnostics

Rejected audits now identify the **1-based candidate number, field and reason**.
The console warning `Campaign audit rejected` adds safe numeric details when
useful (message index, lengths/limits). It never prints RP excerpts, facts,
speaker names, full model responses or provider data. Malformed JSON has a
response-level diagnostic without echoing the JSON parser's input. A valid
candidate followed by an invalid candidate still saves **nothing** and does
not advance the cursor. No partial acceptance or automatic model repair.

The extraction prompt now spells out all field limits and uses a concrete JSON
example rather than pipe-separated enum placeholders. The parser normalizes
case/space/hyphen variants of supported type names, decimal-string message
indices, null optional fields and singleton related names. Unsupported types,
booleans as indices, out-of-batch indices, oversized/invalid fields and unbacked
speaker names are rejected. A narration speaker of “Narrator” is a role label,
not an invented NPC; the actual message speaker remains stored.

Evidence must be a unique literal source excerpt. The only punctuation tolerance
is straight/curly quotation-mark and apostrophe equivalence; matching stores the
**original exact source slice**, so later source-validity checks remain literal.
No case folding, paraphrase, whitespace collapsing, ellipsis expansion or
Markdown stripping is used for quotes. Repeated excerpts require a unique quote.

Provenance is checked against the excerpt's location within the original message.
Straight/curly/single-quoted dialogue remains a claim, including excerpts that
omit enclosing quotes. Apostrophes inside words do not close speech. Backtick
thoughts are unresolved claims, never objective campaign canon. Narration beside
dialogue remains narration when its excerpt lies outside dialogue/thought spans.
Explicitly labelled analyst/OOC blocks, including [WORLD CANON], [INFERENCE] and
[PROPOSAL], are excluded from audit evidence and retrieval eligibility. These
conservative checks are not a universal RP parser; unlabelled analysis, ambiguous
attribution and narrative meaning still require review. Existing data is not deleted.

Regression fixtures use Garrick/Jericho/Black Anchor referrals, Vael/Red Arcade
claims, italic narration, curly apostrophes and backtick thoughts. They reproduce
v2.85.1's rejection of benign contract variations and verify unsupported evidence
still fails closed. The exact original failed model response was unavailable;
diagnostics now make remaining real-world failures specific. Campaign visibility,
mobile positioning and lore-discovery behavior are unchanged.

## v2.85.1 — Campaign Ledger row stays visible

The Campaign Ledger DOM existed in v2.85.0, but long assistant session history
could flex-shrink its container until the summary was clipped and untappable.
The section now retains its size while its expanded content remains capped and
scrollable. Existing mobile panel positioning and lore behavior are unchanged.

`panel_dom_test.mjs` loads the actual extension into a browser, fires APP_READY,
opens the actual panel, and checks that the Campaign Ledger summary is inside
its container, visible, hittable and expandable. It covers empty and populated
sessions at 360, 412 and 1280 pixels. Install Playwright locally, then run
`CHROME_PATH=/usr/bin/google-chrome node panel_dom_test.mjs` (omit CHROME_PATH
when using Playwright's installed browser). Restoring the previous flex-shrink
rule makes the populated-session case fail. The required load gate also guards
the non-shrinking section rule.

## v2.85.0 — provenance-aware Campaign Ledger

Open **Campaign Ledger** inside Chat Assistant. **Audit new RP** initially scans
up to the last 50 visible RP messages; subsequent audits resume at the saved
message index. Each audit sends at most 24,000 characters of complete RP messages
in one extraction generation (8,192 output-token limit; the existing transport may retry once without streaming if stream startup fails). It never uses Chat Assistant session
history, Director plans, or lorebook bodies as extraction evidence. Stop, chat
switches, source edits during extraction, invalid JSON, unsupported quotes and
reported incomplete generations discard the batch without moving the cursor.
A valid empty records array is a successful audit. Messages larger than the input
budget stop the audit explicitly rather than being silently skipped or clipped.

Records begin **pending**. Review their type, provenance, exact supporting quote,
RP message index, speaker and available timestamp, then **Accept** or **Reject**.
Only accepted records with an unchanged source can enter assistant context.
Reject retains a tombstone so exact duplicates are not immediately re-added.
**Re-audit from…** lets you scan an earlier range (0 starts again); decisions and
records are preserved, and subsequent audits continue from that batch. Search
by name, fact, type or status to view older records; the UI renders at most the
20 newest matches. This release offers rejection/re-audit, not freeform editing
of evidence or a destructive one-click rebuild.

### Evidence and storage

The versioned ledger lives at
`chatMetadata.continuityCopilot.campaignLedger`, shared by assistant sessions
within that RP chat, and saved through the existing metadata persistence API.
Each record has a chat-local ID, type, subject, fact/claim, related names, status,
confidence/review state, creation time, source index/speaker/timestamp/quote and
source fingerprint. Editing, swiping, hiding, deleting or reordering its source
makes a record stale and excludes it from retrieval. Re-audit the affected range
to extract a replacement. Chat branches that inherit metadata can inherit valid
prior evidence; separate chats do not share a global ledger.

Supported types: NEW_ENTITY, OBSERVED_FACT, NPC_CLAIM, STATE_CHANGE,
RELATIONSHIP, UNRESOLVED_CLAIM. An entity mentioned only in dialogue has
**DIALOGUE REFERENCE** provenance; it does not prove the character exists or that
claims about them are true. Dialogue cannot be promoted to objective campaign
facts by a model type label, including quoted excerpts stripped of enclosing
quotation marks. Unresolved assertions remain **UNRESOLVED CLAIM**, not canon.
Narration/action can produce **CAMPAIGN CANON**, subject to human review.

Analyst instructions distinguish **[WORLD CANON]**, **[CAMPAIGN CANON]**,
**[NPC CLAIM]**, **[INFERENCE]**, and **[PROPOSAL]**. Selecting a possible future,
inventing motives/relationships or deciding that an NPC acts is a proposal, not
inference. Earlier Chat Assistant brainstorming is never canon evidence. Model
classification is fallible: exact-quote validation proves the text exists, not
that an interpretation is correct; review remains essential, particularly for
unmarked dialogue, unreliable narration and OOC text in RP messages.

### Retrieval and lore checking

Ordinary assistant questions select accepted records by keywords in the current
question, weighting entity/related names above fact text and preferring recent
records for ties. At most **12 records / 6,000 characters** are added, with no
clipped records and no unrelated or stale records. Whole-ledger injection is
excluded by the existing memory reader. Empty/no-match queries add nothing;
mention relevant names for better recall. Matching is lexical, not semantic;
exact normalized source/type/subject/fact duplicates are suppressed, but
paraphrases and renamed entities may need manual rejection. No embeddings,
external database, background extraction, or automatic storyteller injection.
Source fingerprints are cached within each retrieval to avoid rehashing the
same RP message for each candidate. The existing consistency scan includes
accepted campaign facts and directs corrections back to review/re-audit.

Optional **Check entity names in lore** reuses `wiCreateDiscovery` and
`wiLoreSearch`, checking up to 10 new-entity candidates locally and retaining up
to three matching refs each. Matches are explicitly **not verified support**;
no match is not proof of absence. Existing lore discovery still performs its
normal bounded search/fetch flow for substantive world-canon analysis. The
ledger never calls World Info save or promotes anything to lore automatically.
Record/source/lore fields leave room for a future explicit promotion workflow.

### Validation

`node load_test.mjs` covers extraction, dialogue/narration distinctions, entity
references, state changes, source quotes, review, duplicates, incremental scans,
serialization, per-chat isolation, source drift, empty/malformed/truncated output,
context limits and reuse of lore search without writes. Existing lore and mobile
opening guards remain in the same gate. `mobile_layout_test.mjs` checks the
confirmed transformed-root mobile layout; browser UI checks also exercise audit,
accept and reject at mobile and desktop widths. The 2.84.2 mobile positioning
rules and existing Director/session flows are preserved.

## v2.84.2 — mobile panel positioned inside the screen

Fixes an opening failure reproduced against a real SillyTavern installation in
mobile Chrome emulation: the menu click set the open flag, but the panel occupied
`y=-532.8..0` at a 384×740 viewport. SillyTavern transforms its HTML root and fixes
the body on mobile, leaving a zero-height containing block for fixed descendants.
Our mobile `bottom: 0` placed the entire panel above the screen. Desktop mode
used a top anchor and therefore worked.

The mobile panel now uses a viewport-relative top anchor and dynamic viewport
height, with a `vh` fallback. Its minimum size no longer overflows short phone
viewports. Menu/slash wiring and the full assistant functionality are unchanged.
Fullscreen retains its existing top anchor. No diagnostic-only build is shipped.

Architecture invariant: mobile panel coordinates must not depend on the height
of SillyTavern's transformed root. `mobile_layout_test.mjs` reproduces that host
layout and checks visible, hittable windowed/fullscreen panels at five viewport
sizes. Run it with Playwright installed and `CHROME_PATH` set if needed. The
required `node load_test.mjs` gate also guards the mobile CSS anchors.

## v2.84.1 — lore generation continuation and incomplete-output handling

Fixes the generation path used after `wisearch`/`wifetch`, without changing lore
retrieval limits. The previous fallback call omitted `responseLength`, so
SillyTavern used its global response length instead of Chat Assistant's configured
output budget. Each request now explicitly receives its own budget, including
recovery requests. Tool rounds were not subtracting from a shared output-token
pool; the omitted fallback argument was a separate generation-budget bug.

The transport now retains answer text, structured reasoning, finish reason, and
usage when exposed. Non-streaming Connection Profile calls request raw data;
the current-connection fallback prefers `generateRawData` where available,
avoiding `generateRaw` cleanup that throws **No message generated** when the
extracted answer is empty. Older hosts using `generateRaw` still receive the
output budget and get bounded recovery for that error. Unknown response objects
are no longer stringified and displayed as if their JSON were an answer.

SillyTavern's cumulative stream snapshots replace the previous snapshot rather
than appending a revised answer to it. Legacy delta chunks remain supported.
Interrupted streams retain their partial output and real error; nested provider
errors retain their cause instead of only showing “API request failed.”

Lore rounds explicitly check empty output, provider-reported token truncation,
unclosed lore tool blocks, and short prose ending in a dangling colon (including
the reported Veracruz lead-in). An unusable generation gets **one complete-response
recovery** with a fresh enlarged output budget, capped at 32,768 tokens. This is
in addition to the existing configured reasoning-only recovery. Successful
recovery resumes the same search/fetch flow. Persistent failure retains the
partial output as an **INCOMPLETE note**, with backend, requested budget and
available stop reason; it is neither stored as a completed assistant answer nor
passed to edit ingestion. Authentication/context/provider rejection errors are
surfaced, not automatically retried as empty answers. Stop prevents recovery.

Some SillyTavern stream adapters omit finish reasons; diagnostics say so. The
short lead-in check is a heuristic, not proof that arbitrary prose is complete.
The user's original provider trace was not available, so the exact provider
termination behind those two observed attempts cannot be asserted. The missing
budget, discarded reasoning/metadata, and silent acceptance of incomplete output
were reproduced against v2.84.0 and corrected.

Compatibility references: SillyTavern [`generateRaw` / `generateRawData`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js),
[Connection Profile requests](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/shared.js), and
[structured/streaming response contracts](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/custom-request.js).

Validation covers search → continuation; search → fetch → synthesis; empty and
reasoning-only generations; legacy fallback exceptions; explicit token-limit
finishes; the exact dangling lead-in; malformed intermediate JSON/markup;
provider errors; cumulative/revised/interrupted streams; and Stop during recovery.
Desktop and mobile-touch browser fixtures also exercise empty-response recovery
followed by truncated-synthesis recovery, ending in a complete answer with zero
World Info writes. These use mocked provider responses, not a live user's model.

## v2.84.0 — selective lore discovery

Ask ordinary questions such as **“What factions could plausibly have connections
to this situation?”** Selective lore discovery is on by default in the gear
settings. It takes priority over the older full-book injection switch. Turn it
off to use the legacy catalog/full-text modes.

The extension loads the chosen books into a **local, per-request search index**.
It sends only a small page of matching titles, keys, and explicitly clipped
previews. The assistant can search again with names or aliases, fetch selected
entries, and follow relationships into other entries. It is instructed to cite
`WB[book#uid]` and separate **[CANON]**, **[INFERENCE]**, and **[PROPOSAL]**. These
are model instructions, not an automatic fact checker.

- The manual book-name list takes precedence. Otherwise discovery combines
  global selections, the chat binding, primary character/group-member bindings,
  and the persona binding. Extra character bindings are included when the host
  exposes `charLore`; on builds that do not expose it, enter those book names in
  the manual list. This does not emulate or modify the storyteller's activation
  rules, probabilities, or recursive injection.
- Search is local lexical matching over titles, primary/secondary keys, and
  bodies, with title/key weighting and rarer terms weighted higher. It requires
  no embedding service. Related concepts without shared words may need another
  query; a no-match result is not proof of absence. Disabled entries are excluded
  from normal search, and explicitly fetched disabled entries are labeled.
- `<wisearch>{"query":"harbour factions","offset":0}</wisearch>` returns up to
  12 candidates and a `nextOffset` for pagination. An empty query browses titles.
  Previews are unquotable hints; the assistant must fetch before citing or editing.
- `<wifetch>["Terranovia#17","Terranovia#42@2"]</wifetch>` retrieves selected
  text. Long entries use 6,000-character parts with exact counts and an
  **INCOMPLETE** marker. At most 10 references are considered per fetch, with a
  24,000-character response cap and a 48,000-character retrieval budget per run.
  Limits and undelivered references are reported; repeated parts are not resent.
- Discovery allows at least four follow-up rounds (five assistant rounds total
  at default settings), bounded by the existing fetch loop. Existing transport
  retries can add provider calls. Exhaustion produces an explicit incomplete
  status rather than presenting a tool request as an answer. Scope is ordinary
  assistant chat/regeneration; the separate Director and deep-audit flows retain
  their existing context behavior.
- No persistent index: each run reloads current books, so edits and book changes
  take effect on the next request. Stop/chat-change checks bracket index loading
  and model calls. Discovery itself does not save or activate any entries; the
  existing proposal/Apply/Undo editing workflow remains in place.

Validation includes a synthetic 294-entry book measuring 1,604,763 serialized
characters. The tested faction → guild lookup accumulated 1,157 characters of
lore results across its requests. This demonstrates selective transport for
that fixture, not a prediction for every question or a test of the user's actual
Terranovia book. Desktop Chrome and mobile touch emulation also exercised an
ordinary lore question, fetch, cited response, and zero World Info writes.

## v2.83.2 — restore the full extension and repair menu opening

Replaces the diagnostic-only v2.83.1 with the complete extension from commit
`19930328aae9a021f0e60cf241aeb8a681121ef2`, preserving settings and per-chat data
under `continuityCopilot`. The display name is **Chat Assistant**.

The wand item follows SillyTavern's built-in caption menu pattern: an
`extension_container`, the native icon class, and a jQuery `click` handler.
Clicks bubble to SillyTavern's menu closer; there is no separate `touchend`
handler that cancels the browser's click. Menu activation opens the panel
idempotently, so a repeated/compatibility click cannot immediately close it.
Enter and Space also open it. A missing menu leaves initialization retryable.

The restored build also had a concrete DOM mismatch: its panel and viewer
were created as `cc_*`, while lookups and CSS expected `chatassist_*`.
Creation now matches those lookups. Storage keys and CSS classes are unchanged.
The integrity harness now targets the actual namespaced DOM IDs rather than
the stale IDs from before the earlier migration.

Reference: SillyTavern's [caption menu registration](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/caption/index.js)
and [wand menu click handling](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js).

Validation: `node load_test.mjs`, plus headless Chrome with real jQuery and the
full extension/CSS at desktop size and a 412×915 mobile touch viewport. Checked
label/icon activation, jQuery-triggered clicks, repeated opening, keyboard
activation, menu dismissal, and panel closing. The browser fixture mocks the
SillyTavern context; it is not a full running SillyTavern installation or a
physical Samsung A32. The diagnostic's phone-specific failure is not reproduced
or conclusively attributed by these tests.

## The one-line idea

Instead of hand-editing your chat log and juggling separate tools for memory and worldbook, you get **one assistant that sees all your story data at once and edits it surgically** — with a red/green diff preview, fuzzy matching so it doesn't have to quote perfectly, and one-click Undo for everything. Keeping those stores mutually consistent is the whole point.

It runs on a **separate Connection Profile** (never your main roleplay model), so auditing never touches story generation.

## What it can do

**Talk to it in plain language.** *"Why is Jillian on the train? She's at the academy — fix it."* It reads your memory + chat, proposes exact find/replace edits as cards, and applies them on Apply.

**Edit three data stores, kept consistent:**
- **Chat messages** — find/replace or whole-message rewrites, hide/unhide (OOC cleanup).
- **Memory** — your Summaryception (or other memory-extension) data: the Plot-Essential notepad and summary snippets, via find/replace or whole-field replace.
- **Worldbook (World Info)** — read, create, edit, delete entries plus their keys and config, all from chat.

**Shortcut commands** (type the tag; all editable in settings):
- `#f` — check the chat against memory and fix continuity errors.
- `#s` — check the current session against memory.
- `#m` — **deep audit: everything, in four passes** — and it sweeps the **visible** chat only. Ghosted messages are already represented by memory snippets, so re-reading them linearly audits the same events twice; their originals are pulled only where a pass says it cannot settle something. Before it starts, it prints the scope and the cost ("8 visible of 20 → about 2 continuity calls, budget 40"), and a call budget stops it at a saved resume point instead of running for an hour. (1) **Structure**, scanned in code before any model call — unbalanced `<details>` blocks, the *same* block duplicated inside one message (the previous scene's block glued into this one), text welded onto a closing tag, and blocks whose field set has drifted from the shape the rest of the chat uses. (2) **Continuity** of the whole log against memory, window by window — not a sample. (3) The **memory against itself, as one ordered story** — every entry is indexed in story order (a *spine*: entry number, coverage range, 90-character extract) and that index ships with **every** section call, so a contradiction between entry 5 and entry 98 is visible even when only one of them is in the window. Findings carry forward from section to section, and when the memory needs more than one section a **cross-section pass** runs specifically for faults that live *between* distant entries. Coverage ranges are also scanned in code for backwards, overlapping, duplicated and missing spans. Chunk boundaries never fall inside an entry. (4) **Verify** — pulls the original ghosted messages, but only the ones pass 3 named as doubts. A memory that checks out costs zero calls here. `#m ghosted` also repairs broken blocks inside ghosted messages, which are otherwise reported but left alone. Narrow it with `#m structure`, `#m from 180`, `#m restart`; a stopped run resumes where it stopped, and the extension remembers where that was — you are never asked "tell me where to continue."
- `#a` — fidelity audit on its own: do the memory snippets match what actually happened?
- `#o` — harvest OOC/meta asides from the chat and hide them.
- `#i` — brainstorm distinct directions for what happens next.
- `#p` — psychology read of a character: drives, contradictions, consistency vs. canon, likely next move.
- `#opt` — **memory optimize**: zero-loss token reduction, section by section (sequential aggregation, reference stripping, dialogue-surround and emotional-texture compression, causal-chain notation), with the 4-question test on every sentence and a mandatory zero-loss verification before anything is proposed. Never touches the notepad or a pinned quote.
- `#cl` — **memory cleanup**, the showrunner pass for a cluttered story: throughline, cold-read test, broken coherence, what's missing, motivation check, then a SPINE / SUPPORT / TEXTURE / NOISE manifest. Subtractive proposals only; restructuring is described and waits for your go-ahead.
- `#br` — a short handoff paragraph for a fresh storyteller: where the story stands, what's in motion.
- `#d <text>` — steer the Director mid-episode.
- `#e <text>` — co-write: seed the next episode with your own premise; the Director expands it into a hidden episode built around it.

**Two autonomous systems** (opt-in, run on a cadence on the assistant's profile, never on your main model):
- **Director** — writes secret per-episode directives (hidden `[EPISODE_END]` markers) that give NPCs and the world their own initiative and give pacing an arc, injected into your storyteller so the world acts *on* the protagonist. Three modes: **Auto** (AI invents and chains episodes on its own), **Co-writer** (each episode grows from *your* one-line seed via `#e`/🎬 Seed — the AI drafts the hidden beats around it, and 💡 Seed ideas proposes three doors when you're blank), and **Off** (manual buttons only). Peek/edit/`#d` work in every mode. **Restart** — with a live directive the `🎬 New` button becomes `🎬 Restart`: it throws out the current episode's directive and rewrites that episode from scratch, keeping its number. The rejected directive is shown to the model as *never aired and not canon*, with an explicit brief to take the road not taken — a different premise, centerpiece, shape, and dilemma — so a restart never hands back a variation of what you just rejected. Directives are **sovereignty-planned** for choice-driven play: the premise names an open **EPISODE QUESTION**, beats are written as the world's half of the collision and stop at the player's decision point ("the bullies corner the transfer student in front of you" is a beat; "you step in" is a stolen choice — and so is "your power slips out involuntarily": the plan may never make the player the subject of a sentence, voluntary or not, body, mouth, or mask; it schedules world events and choreographs only the NPC half of them), and the landing maps consequences **per possible answer** instead of scripting one outcome — the episode ends when the player has answered the question on screen, whichever way they answer. (Use `#d <direction>` instead when you want to *re-aim* the current episode while keeping what works.) Every directive is written in **three passes** (all on by default), one per seat of a real room: the **maker** drafts fast; the **showrunner** interrogates the draft against the best episodes ever aired — is this the most interesting version of the premise, where is the scene the audience will retell, which established character is wasted, where does it play safe — and rewrites it; then the **watcher**, a viewer-seat pass, judges pure enjoyment from the couch and makes the *minimal* final cut — it may sharpen situations, stakes, staging, and NPC behavior, never script a player action (wish for situations, never for answers), it honors editor notes as the player's own voice, and if the episode already airs it ships unchanged. The rule-based laws catch known failure classes; the showrunner pass is what catches the ones nobody enumerated. On reasoning models the passes split the thinking like a real room splits the work: the draft runs in declared **fast-draft mode** (full format, every law, no extended deliberation — the deep pass is coming) and the showrunner review is where the deep thought goes, roughly halving two-pass wall-clock without touching the quality gate. Single-pass mode (toggle off) keeps full deliberation on its only pass. Since v2.67 recognition is **taste, not law**: the recognition-law experiment of v2.65–v2.66 (mandatory audiences, rotation rules, invention caps) is retired — rules that need counter-rules are the wrong mechanism — and the insight lives where taste belongs: the maker carries a **known-delights palette** (repricing scenes cold and warm, underdog vindication before witnesses, small conversions, banter that earns its warmth) to spend when the story genuinely offers them, never as a quota — an episode that honestly offers none is lawful. The **ambient interlude** shape survives with its no-dilemma exemption, but airs on demand — whenever the story is hungry for breath — not on a schedule.
- **Editor** — standing craft notes injected each turn. It patrols the defect floor (scenes circling the protagonist, characters/props vanishing, dead ambient world, agency theft, same-voice NPCs, rushed resolutions, phrase tics) **and** holds the story to a masterpiece bar (dead scenes that don't turn, on-the-nose dialogue, wasted dramatic irony, unpaid setups, escalation-by-volume, frictionless success, furniture characters — named presences with no want and no move, or stakeholders missing from their own jurisdiction). Every pass opens with one **NORTH STAR** line — the single highest-leverage improvement — followed by the numbered standing notes. It can run on a reply cadence *and* (on by default) **automatically when an episode concludes**: the editor reviews the aired episode first, and in Auto director mode the next episode is then designed with the fresh notes in hand — a writers'-room review→plan loop.

**Chat-file naming** — *Auto-name this chat* reads the thread and suggests a distinctive title so branches/checkpoints are tellable apart; *Rename this chat* for a manual name. (Uses ST's `/renamechat`.)

**Safety net** — *Reset ALL settings to defaults* restores the tested baseline in one click (keeps your Connection Profile; never touches chats or memory).

**Everything is undoable** — chat, memory, and worldbook edits each push a typed Undo entry that restores byte-for-byte.

## The memory auditor, brought inside (v2.73)

Summaryception ships `MEMORY_AUDITOR.md` — a protocol you paste into another AI, along with an exported Memory Transplant `.md`, to get the memory audited and a whole repaired file back to re-import. The doctrine is excellent; **the round trip is the flaw**. One wrong number costs a full export → audit → import cycle, the whole file is replaced to change one line, and the auditor never sees the chat the memory came from — so it can only check the memory against itself.

The same mandates now run **inside the panel, against the live memory and the live chat**, and every fix arrives as a reviewable card:

- **M-RECORD** — record-only: repair and reorganize what exists, never invent events, motives or connections to justify a cut.
- **M-EPISTEMIC** — knowledge needs a pathway: a dossier that "knows" a secret with no discoverable route to it loses the knowledge; a pathway is never invented to launder the leak.
- **M-SCAN** — every error names a *class*, and the class gets swept before the answer. Wired to the extension's `bulk_replace` so a class that repeats verbatim across the chat is fixed in **one** edit, not one per message.
- **M-EYE** — every reply carries what was found while in there and the evidence the sweep happened.
- **M-TAGS** — `[CANON]` / `[INFERENCE]` / `[SPECULATION]` in the report; never a tag or a note written *into* the data.

Plus the shape rules the protocol depends on: the **notepad is the opening state on purpose** — later events outgrowing it is progression, not staleness, and it is never "refreshed" (a pass that reconciled it against the snippets would propose destructive edits to the author's own starting canon); ledger dossiers keep CORE / STATE / ARC / THREADS distinct; pinned quotes are never reworded.

`*fix` has no equivalent here because it needs none: proposals are staged as cards and **Apply is the approval gate** the paste-in protocol had to ask for in prose.

## How it sees your story (context built per request)

1. **[STORY MEMORY]** — every registered memory-extension prompt whose key matches a regex (default `summar|ception|memory|qvink`, i.e. what Summaryception injects), plus matching chat-metadata keys, plus the Author's Note.
2. **[MESSAGE INDEX]** — one line per message (`#id [speaker] preview`); hidden/ghosted messages excluded by default.
3. **[FULL MESSAGES]** — the last N **visible** messages (default 8), each one **whole**; ghosted and hidden rows are skipped (memory already represents them), and anything outside the window is one `<fetch>` away.

If it needs older messages it replies with `<fetch>[12, 13]</fetch>`; the extension auto-sends those and re-asks (up to "Fetch rounds" times), keeping token cost low in long chats.

**Whole means whole (v2.72).** Every message handed to the assistant — in `[FULL MESSAGES]` or a fetch result — carries a header with its **exact character count** and one of two verdicts: `COMPLETE` (the entire message, first character to last) or `PART n OF m ... INCOMPLETE`. Until v2.72 the code did a bare `.slice(0, 8000)` with no marker of any kind, so a long scene arrived as a mid-word stump *labelled as its full text*: the assistant then reasoned about where the message **ended** from a boundary the tool had invented, and every edit that shortened the message slid that boundary and "revealed" fragments that had been there the whole time. Cap is now `0` (no cap) by default. If you deliberately set a **Message text cap**, over-cap messages are served in numbered parts with a loud banner and the exact ref for the rest (`<fetch>["217#2"]`) — never a silent stump. Slices carry an explicit ban on structural conclusions, and an edit anchored in a slice triggers the auto-fetch instead of being staged. A fetch that asks for more ids than one round serves now **reports the ids it did not serve** instead of dropping them.

## Absence is a claim you must earn (v2.83)

The deep audit's most dangerous failure isn't a wrong match — it's a **conviction**: the memory pass deciding a recorded event is *invented* ("the chat never shows Rias refusing the number") and staging edits that **remove the fact from every memory surface** — founded on chat text it never read. Ghosted originals carry no preview in the index, so "not anywhere I can find" meant "not in the zero messages I held." The user then has to defend their own canon against a tool that was supposed to protect it. Three unarmed gaps closed:

- **"Invented" is now unreachable from memory alone.** The memory pass states the absence law: declaring the chat *lacks* an event requires reading every original that could contain it — the coverage range, pulled complete. Until then the lawful moves are naming the range in `<verify>` or reporting the entry UNVERIFIED — never staging a removal/softening edit on an unproven absence. *"Not in what I was shown" is a finding; "not in the chat" is a claim you earn with originals.*
- **Read for event, not staging.** A beat delivered indirectly — a watchlist line, an off-screen reference, narrator shorthand — still counts as the chat showing it. "Not shown directly" is a style note, never an invention verdict. (This was the exact rationalization in the flip-flop.)
- **The verify pass cleans up after the earlier passes.** It now receives the live PENDING PROPOSALS list (with labels) alongside the originals, with an explicit mandate: re-examine every staged proposal against the evidence you now hold — above all any that called a recorded event invented — and `<supersede>`-withdraw the refuted ones. A proposal the originals contradict never reaches your review as a live card.

## Stale cards say so; agreeing means withdrawing (v2.82)

The withdrawal protocol (v2.78) taught the move, but two triggers were still unarmed — and a staged-but-wrong card could survive three rounds of the user demanding its death:

- **The model couldn't SEE the "already done" case.** A pending card whose anchor had gone dead (the text got fixed by another route, or moved) read exactly as confident in the pending list as the day it was staged. The block now re-checks every active proposal's anchor against the **live** text each time the list is built, and prints **⚠ STALE** on the dead ones — "already fixed / text changed" becomes a printed fact the model acts on, never something it has to guess. Withdraw it, or re-anchor it immediately.
- **The agree-in-prose trap had no name.** When the user says *"why did you suggest that?"* the model's instinct is to apologize and move on — and the bad card stayed staged, re-listed next turn, exactly the loop being complained about. The rule now names the moment: when you catch yourself **agreeing with the user** that a pending proposal is unnecessary, the `<supersede>` block rides in *that same reply*. Agreeing in prose without the block *is* the failure.

## Ghosted originals: read on doubt, never unhide (v2.81)

Ghosted messages never stopped being readable — `<fetch>` serves any id whole, and the deep audit's verify pass is built entirely on pulling ghosted originals when the memory pass names a doubt. What was missing was the ordinary-chat prompt *saying* so: the edit rules declared "NEVER unhide '(ghosted by memory)' ones" one bullet away from the fetch rules, and a careful model could read that as *never touch ghosted messages at all* — refusing to read an original it was always allowed to read.

The rules now separate the two acts explicitly: **reading a ghosted original on a real doubt is lawful** (settling a contradiction, checking a thin snippet, editing one); **unhiding it is what's forbidden.** Reach for the memory snippet first — the original is the exception, not the default, because pulling originals costs real time. A gate guard now proves the fetch path never filters ghosted ids, so this capability can't silently regress.

## The full-text window counts what it can act on (v2.80)

**"Recent msgs sent in full"** now counts **visible** messages, not raw chat rows. Set it to 100 over a chat where only 14 messages are unghosted and the assistant reads exactly those 14 in full — before, it took the last 100 *raw* rows, so ghosted entries falling inside the tail were served whole too.

Two reasons that's the right semantics, not just a preference:

- **A ghosted message is already paid for.** Its content lives in the memory snippet covering it; serving the original whole in the window is the same rent twice — the exact double-reading the deep audit was taught to avoid in v2.74. The originals remain one `<fetch>` away whenever a real doubt needs the actual wording.
- **A hidden message must stay hidden.** Hiding means "out of AI context" — but a hidden row inside the raw tail was served in full to the assistant through the window, quietly defeating the hide. The window now skips it like the index does.

The blind-edit guard moved with it: the "has the model actually read this message" test now uses the same visible window, so an edit aimed at a ghosted row inside the raw tail is correctly treated as unread and auto-fetched first — while an edit to a visible message inside the window no longer triggers a pointless fetch just because its raw id sits below the old raw-arithmetic threshold.

## Fetching is the block, not the words (v2.79)

Ask a story question whose answer lives outside the full-text window — *"did the sister ever tell him about her ex?"* — and three things used to go wrong, all from the same gap between what the protocol *meant* and what it *said*:

- **The assistant asked YOU for permission to fetch.** "Want me to fetch the chat?" is a wasted turn: the user cannot fetch, only the `<fetch>` block can — but nothing in the prompt said so, so a well-mannered model asked. Rule 2 now states it outright: fetching is free, instant, automatic, needs no permission, and must never be asked about or announced — *"let me fetch…"* does nothing, the words are not the tool, the block is the tool.
- **It answered from previews.** A `[MESSAGE INDEX]` line is 150 characters that say *what is roughly where* — nothing stopped a model from treating it as enough, and guessing is hallucination. The rule now draws the line: if memory and the full messages don't settle the question, fetch first and answer from real text.
- **A malformed fetch died silently.** `<fetch>the sister's messages</fetch>` — words instead of ids — parsed to the same `null` as "no fetch requested": the prose was displayed, the block stripped, and nothing ever came back. You watched the assistant announce a fetch that never ran. `parseFetch` now distinguishes *absent* from *unreadable* and says why; both the chat loop and the audit loop hand the reason back to the model once ("resend it as `<fetch>[12, 13]</fetch>` — real numeric ids only"), show you a warning, and if the block comes back malformed again they say so instead of letting the reply pass as answered.

## Withdrawing a dead proposal (v2.78)

The proposal protocol taught three moves — propose, correct (`<supersede>` + a fresh edit), apply/skip — but no **withdraw**. When the assistant re-read the current text and concluded a staged or failed proposal was simply *wrong, moot, or already resolved*, its two prompt-sanctioned options were to re-send the proposal (wrong) or to say so in prose (which changes nothing, because prose never touches the staged list). The failed-apply retry even said "do not re-send proposals that are no longer needed" while the pending block said "do not drop them silently" — so the assistant said "dropping it" in chat, the dead cards stayed in PENDING PROPOSALS, and every later turn re-listed them: an endless loop that read as the assistant refusing to act on its own verdict.

`<supersede>` with no replacement already *worked* in code — it was simply never taught for that purpose. Now it is, at all three sites that govern the loop: the pending-proposals block, the failed-apply coaching, and the retry button's prompt all state the fork plainly — **re-propose corrected, or withdraw by naming the label in a `<supersede>` block; the block is the only thing that removes a proposal, prose removes nothing.** A supersede-only reply is reported as *"withdrew"* rather than *"replaced."*

Two silent failures closed with it: a supersede label that matches **no** pending proposal now raises a visible warning naming the unmatched labels (the assistant used to announce a dismissal that never happened), and label matching is normalized so a near-miss like `memory fix #1` still lands on `Memory fix 1`.

## One fact, every surface (v2.77)

A story fact is written in several places at once: the chat prose (often in more than one message), the memory snippet covering it, that snippet's detail/audit field, the ledger dossier for each character involved (CORE / STATE / ARC / THREADS), the notepad, the worldbook entry. **Correcting one and leaving the rest does not half-fix the error — it manufactures a new one,** because the surfaces now disagree with each other.

Until v2.77 the auditor doctrine only shipped inside the `#m` passes, so an ordinary "fix this contradiction" arrived with no rule about the other surfaces at all — and a fix landed on the chat and the ledger while the snippet, its detail field and the worldbook kept saying the old thing. Two things changed:

- **The consistency law ships on every request**, not just audits, and it names the surfaces concretely instead of saying "be thorough". It also demands the sweep be *reported with numbers* — "chat: 3 instances, all fixed; snippet + detail: both fixed; Cersei STATE: fixed; worldbook: checked, none" — because an unmentioned surface reads as an unchecked one.
- **A ripple scan proves the leftovers in code.** The extension works out what an edit actually removes (find and replace minus their shared head and tail, so changing "Two-fourteen" inside a long anchor yields `Two-fourteen`, not the sentence), then finds every other place that text still sits — other messages, memory paths, ledger dossiers, worldbook entries — and hands back the list with exact counts. The assistant sweeps them in the same run. A model cannot forget a surface it has been shown a count for.

It also asks for the **downstream** ripple: a corrected fact can invalidate what was written after it — a consequence that no longer follows, a count computed from the old value, knowledge a character could only have had under the old version.

A fix with no leftovers costs no extra round. A rename spanning thirty messages does raise the sweep — that is the case it exists for — and one `bulk_replace` is offered instead of thirty edits.

## Anchors: why a proposal used to fail and need re-asking (v2.76)

An edit is a find/replace, so its `"find"` must be a **copy** of the target text, not a description of it. Three things used to break that:

- **Nothing checked the anchor until Apply.** A `"find"` that did not exist sailed through staging and only died when you pressed Apply — becoming a failed card *you* had to notice and ask about. Now every proposal is checked at arrival with **the same resolver the apply uses** (fuzzy floor included), so a flag is a guaranteed failure and never a false alarm. A valid anchor costs no extra round.
- **When one is wrong, it is corrected in the same run.** The assistant gets an `[ANCHOR CHECK]` turn naming exactly which target it missed and what it was holding, and re-sends the corrected proposal — once, never a loop. You see one note and the right card.
- **Derived text was quotable.** The `[MESSAGE INDEX]` preview (150 chars) and the `[MEMORY SPINE]` line (90 chars, whitespace-collapsed) exist to say *what* is there and *where*. Anchors built from either can never match. Both blocks now declare themselves unquotable in their own headers, and the non-editable contract states it outright: **anchors are copies, not descriptions.** If the assistant does not hold the full text, it asks for it (`<fetch>` a message, `<verify>` a memory entry) instead of reconstructing it.

**And the stale card is gone.** Superseding an older pending proposal used to require the anchors to be *identical* — which a corrected re-proposal can never be, since a different anchor is the entire point of correcting it. So the wrong card sat there and you dismissed it by hand every single time. A pending card whose anchor no longer matches is now retired automatically by any newer proposal for the same target, labelled *"its anchor no longer matches; replaced by the newer proposal."* A pending fix whose anchor is still good is never touched.

## How edits work

The assistant proposes a strict block, e.g.:

```
<edits>
[{"id": 27, "find": "she watched the countryside blur past", "replace": "she watched the academy courtyard", "reason": "Jillian is at the academy"}]
</edits>
```

parsed into red/green cards with Apply / Skip / Apply-all / edit. Matching is exact -> quote-normalized -> fuzzy word-window Levenshtein (78% threshold), so a slight misquote still lands. Omitting `find` replaces the whole message. Memory uses `<memedits>`; worldbook uses `<wiedits>` / `<wifetch>`; each with the same diff-card + Undo flow.

## How it differs from ST-Copilot (the inspiration)

ST-Copilot is a broad chat manager (sessions, themes, stats, and more). Chat Assistant took the "AI that edits your chat" idea in a different direction: **original code, focused entirely on continuity and craft**, then extended into memory + worldbook editing, the Director and Editor showrunner systems, character-psychology analysis, and chat-file naming. It's designed to sit *alongside* a memory extension (like Summaryception), not replace it: **memory holds the developmental record; this assistant audits, repairs, and directs.**

**Pause without losing anything** — two settings checkboxes, `⏸ Pause Director injection` and `⏸ Pause Editor-notes injection`: the directive / standing notes stay stored (Peek still shows them, the copilot can still read them) but are actively cleared from the storyteller's prompt until unpaused — cleared, not skipped, because a previously set extension prompt persists until overwritten. The panel sub-line shows `🎬⏸` / `📝⏸` while paused so a silent pause can't be mistaken for a broken director. While a channel is paused its automation stands down too — auto-director, auto-critique, and the episode-end editor pass all skip rather than burn reasoning calls on content the storyteller cannot see, and manual generations carry an explicit PAUSED warning. Automation resumes on the first reply after unpausing.

**Reasoning models, tamed not disabled** — the director/showrunner/critique prompts carry explicit deliberation discipline (the token budget is shared between private reasoning and the answer; settle, commit, write), and the think-consumed recovery is structurally fixed: it retries in an **enlarged pot** (2× base, capped 32k) with a one-sentence escape hatch for forced reasoning phases and the reasoning transcript fed back for transcription — because a same-size recovery over a longer input was mathematically doomed to be consumed again, which is what "thinking and thinking for 40k" was. Thinking models keep their depth; they just stop starving the answer.

**End season, scope-honest** — `🏁 End season` clears only the final episode's directive and says exactly that to the residue audit, with a deterministic played-state the extension computes itself: **NEVER PLAYED** (zero storyteller replies since the directive was set — the audit is told chat absence is expected and forbidden from hunting for missing beats), **PARTIALLY PLAYED — about N replies** (what aired is history and stays; only the unaired remainder is scrubbed), **CONCLUDED**, or UNKNOWN for directives from older versions. Earlier episodes of the season are explicitly fenced off as real history, and the audit has a mandated clean exit: nothing found = one line, zero cards. Ending a season to reset or clear corruption no longer sends the model spiraling over beats that were never played.

**Liveness readout** — every busy state (directing, showrunner pass, editor, seeds, status, edit) is a live ticker, not a static label: elapsed seconds, streamed character counts (`1240 chars (+3100 thinking)`) that climb chunk by chunk, the current phase (`draft` → `showrunner second draft`), and an `auto-abort in Ns` countdown showing exactly when the stall watchdog will give up. Directive secrecy holds — the readout is counts only, never content. With streaming off it says so and points at the setting.

**Reliability** — every LLM transport await (stream start, each stream chunk, plain requests, the fallback backend) runs under a stall watchdog (`LLM stall timeout`, default 300s, 0 = off): a provider request that never settles is aborted with a loud error instead of holding the extension's `running` flag forever — which previously turned one hung request into every button on every model silently doing nothing until reload. ⏹ Stop now also force-unblocks the in-flight await even against backends that ignore AbortSignal. And pressing any action while another is in flight tells you so with a toast instead of silently returning.

## For a future maintainer (architecture at a glance)

- **⚠️ THE GATE — run before every push: `node load_test.mjs` (exit 0 or DO NOT PUSH).** SillyTavern loads `index.js` as an **ES module**; `node --check index.js` parses CommonJS and silently accepts what ESM rejects. This repo was gated on syntax alone until v2.51.0. The gate really executes the module against a mocked SillyTavern, drives `init()` through `APP_READY`, asserts the panel built and every event handler bound, and carries source-witness assertions for the shipped invariants: the cross-chat contamination guards (`sameChat` in the ask loop, apply run, undo, and episode conclusion), the v2.52 craft doctrine in the director/seed/critique prompts, the episode-end review→plan chain ordering, and the v2.63 player-sovereignty format (stop-at-the-player beat grammar, open landing with per-answer consequences, showrunner SOVEREIGNTY interrogation, question-answered episode end), and the v2.64 version lock (the in-code header stamp must equal the manifest version) plus the total-subject sovereignty law (the involuntary loophole, premise presupposition, and world-staged TURN/MOMENT), and the v2.65 recognition grammar (RECOGNITION LAW with resistance-first staging and on-screen reprice, ambient-interlude DILEMMA exemption, showrunner interrogation 7, and a sha256-pinned V264 freeze that fails on any byte of drift), and the v2.66 audience balance (now historical, witnessed in the sha256-pinned V265/V266 freezes), and the v2.67 three-layer room (known-delights palette explicitly taste-not-quota, delight-free episodes lawful, ambient on demand, watcher pass existence + sovereignty + minimal-cut + empty-fallback + toggle round-trip, and end-to-end behavioral proofs of the three-pass order, screening-copy handoff, showrunner fallback, two-pass toggle, and restart addendum), and the v2.68 integrity pack (drift-guarded undo restores, synchronous card claim, cross-field fuzzy-anchor uniqueness, payload-channel-aware hand editing, and the low-severity hardening set), and the **v2.69 run-lifetime pack**: `beginRun()` proven to be the *only* place the lock is taken and the *only* place the stop flag is cleared, `callLLM` proven to refuse a request once the run is stopped, undo proven to restore into the CAPTURED chat and to put a batch back when a restore throws, `addBubble`/`addAiBubble` proven to degrade instead of throwing past a caller's lock, and both fire-and-forget `applyEdits` call sites proven to carry a rejection handler — with two end-to-end behavioral proofs (a Stop pressed during a worldbook read fires exactly one request, and a throw mid-undo keeps the batch so the retry succeeds). Every v2.69 guard was negative-tested: each bug was reintroduced in a scratch tree and the gate confirmed to exit 1. — and the **v2.71 correctness pack**: one canonical numeric coercion (`numSetting`) proven to keep a typed 0, a blank box and garbage as three *different* answers all the way through to the real `setExtensionPrompt` depth argument, no truthy-only fallback left on any numeric setting, and node-scoped memory undo proven end-to-end (the edited field restores through a sibling write under the same root; the sibling write survives; a drifted field is refused *by field name*; a deleted path is refused instead of resurrected; and the receipt matches reality for clean, mixed and fully-refused batches). All eleven v2.71 guards were negative-tested the same way. — and the **v2.72 whole-message pack**: a 20k-char message proven to reach the model with its real ending intact and an exact-count `COMPLETE` header; an over-cap message proven to arrive as `PART n OF m` with the missing-character count and a working `"id#part"` ref that resolves to the right slice; over-cap fetch ids proven to be *named* rather than dropped; an edit anchored in a slice proven to trigger the auto-fetch; the structure scanner proven to name a duplicated block by its summary label, a fragment welded to a closing tag, and a block whose field set drifted from an established norm (with the norm's 3-message evidence threshold proven to keep a young chat quiet); the four-pass deep audit proven to walk *every* window of the log, to run the memory and fidelity passes unasked, to persist a resume cursor when stopped and to resume from it; and the message-text contract proven to ship even with a fully customized system prompt. All eleven v2.72 guards were negative-tested: each bug was reintroduced in a scratch tree and the gate confirmed to exit 1. — and the **v2.73 auditor pack**: all four audit passes proven to carry every mandate (record / epistemic / scan / eye / tags), the class sweep proven to name the real `bulk_replace` rather than leave it as advice, the notepad-is-static law proven present and the old notepad-vs-snippet reconciliation proven gone, `#opt` proven to carry the zero-loss contract, the eight ordered techniques and the notepad/pin ban, `#cl` proven to carry the director's read and the SPINE/SUPPORT/TEXTURE/NOISE manifest with its keep-when-unsure safeguards, memory proven untouched by a pass (staging only), and each new command documented exactly once. All six v2.73 guards were negative-tested. — and the **v2.74 scope pack**: the continuity sweep proven to build its windows from visible ids only (8 visible of 20 = 2 windows, not 5), the scope and cost proven to print before the run, pass 4 proven to pull exactly the ids pass 3 doubted (range syntax expanded) and *zero* when the memory raises none, ghosted structural faults proven to be reported without spending a call until `#m ghosted` asks, and the call budget proven to pause the run with its resume point intact. All six v2.74 guards were negative-tested. — and the **v2.75 narrative-order pack**: the spine proven to ship with every section call and to run from the first entry to the last with coverage ranges, findings proven to carry between sections, the cross-section pass proven to run on a multi-section memory and to be skipped (and not charged for) on a single-section one, an over-budget entry proven to be delivered whole rather than sliced, and all four coverage-order faults (backwards, out-of-order, overlap, gap) proven to be flagged in code before any model call. All six v2.75 guards were negative-tested. — and the **v2.76 anchor pack**: an impossible anchor proven to be caught before staging and corrected inside the same run with the target named, a valid anchor proven to cost no extra round, an invented memory anchor proven to be checked against the live memory, a dead card proven to be retired by its corrected replacement with the reason stated, and a still-valid pending fix proven NOT to be retired by an unrelated proposal. All seven v2.76 guards were negative-tested. — and the **v2.77 sweep pack**: leftovers proven to be counted in code before anything is staged, the other chat message and both memory paths proven to be named individually, the downstream ripple proven to be demanded, the law proven to ship on an ordinary request and to survive a customized system prompt, a leftover-free fix proven to cost no extra round, a thirty-message rename proven to raise the sweep with an exact untouched count and a bulk_replace offer, and audit correction rounds proven to count against the call budget. All seven v2.77 guards were negative-tested. — and the **v2.78 withdrawal pack**: a supersede-only reply proven to withdraw a staged card with the reason stated as a withdrawal, the withdrawal fork proven to ship in the model-facing pending block and the failed-apply retry prompt, a near-miss label (`memory fix #1`) proven to still match, and an unmatched label proven to raise a loud warning instead of a believed-but-fake dismissal. All four v2.78 guards were negative-tested. — and the **v2.79 fetch pack**: a malformed fetch proven to coach the model with the reason and then serve the resent valid request (three calls, answer lands), a repeat-malformed reply proven to stop after exactly one coaching round with a loud warning instead of silence, the no-permission / no-announce / evidence-not-previews contract proven to ship in the system prompt, and the audit loop proven to carry the same coaching. All four v2.79 guards were negative-tested. — and the **v2.80 visible-window pack**: the full-text window proven to count visible messages only (100 over 14 visible reads exactly 14, ghosted text never shipped), and the blind-edit guard proven to use the same window — a ghosted row inside the raw tail is auto-fetched before editing, a visible one inside the window costs no fetch. All four v2.80 guards were negative-tested. — and the **v2.81 ghost-read pack**: a ghosted id proven to fetch whole in the ordinary chat loop (the `fullTextOf` no-filter invariant), and the read-lawful / unhide-forbidden distinction proven to ship in the edit rules. All guards negative-tested. — and the **v2.82 stale pack**: a card whose anchor just died proven to be marked STALE in the very list the model reads, the stale-handling and agree-and-withdraw rules proven to ship in the block, and a model reading its own STALE line proven to withdraw the card in the same reply. All four v2.82 guards were negative-tested. — and the **v2.83 absence-law pack**: a conviction-style edit staged in pass 3 proven to reach pass 4 with the pending list attached, the originals proven served beside it, and the refuted card proven withdrawn inside the same audit run — plus the absence law proven to ship in the memory pass and the re-review mandate in the verify prompt. All four v2.83 guards were negative-tested. — if a refactor removes one, the gate fails until the replacement is proven and the witness updated.
- **Run lifetime:** every asynchronous operation that holds the panel starts at `beginRun()` — the single place that takes the `running` lock, clears `stopRequested`, and sets the busy state. **The stop flag is scoped to the RUN, not to one LLM call.** Clearing it inside `callLLM` (as versions before 2.69 did) erased a Stop pressed between calls of the same run — a fetch round, a worldbook read, or the showrunner/watcher passes — and the run then opened a request the user had already cancelled. `callLLM` reads the flag and refuses; it must never write it.
- **Single IIFE, no imports** — everything via `SillyTavern.getContext()`. Inits on `APP_READY` + a `setTimeout` fallback, guarded by an `inited` flag.
- **Storage:** settings live in `extensionSettings.continuityCopilot`; per-chat state (director, hidden-message ledger, session history) in `chatMetadata.continuityCopilot`. **An undo record must have the same granularity as the edit that created it** — memory backups and drift fingerprints are taken at the edited *node* (`memBackup` / `memPathParent`), never at the root key. Root-key snapshots were wrong twice over: restoring one clobbered every sibling field written since, and the fingerprint then covered the whole root, so any unrelated write under it refused the undo — including this extension's own receipt line into its own metadata, which made `continuityCopilot.director.text` (a path the copilot is explicitly told to edit) permanently un-undoable. **`continuityCopilot` is the internal MODULE id — do not rename it; that would orphan every user's saved settings and per-chat data.** Memory is *read* from other extensions, not owned here.
- **LLM routing:** `ConnectionManagerRequestService.sendRequest(profileId, ...)` with a `generateRaw` fallback, wrapped in `callLLMSmart()`, which recovers from models that spend their whole budget "thinking" (feeds the reasoning back and demands the answer) and auto-continues cut-off blocks.
- **Nothing hands the model message text except `fullTextOf()`**, and it always stamps the completeness header (`_formatMessage`). A truncation the reader cannot detect is worse than no text at all — it produces confident wrong answers — so any future size limit must go through the PART mechanism, never a bare `.slice()`. `msgServedWhole(id)` is the single predicate for "has actually read it"; the blind-edit guard asks it rather than trusting that a fetch happened.
- **Structure before inference:** `scanMessageStructure` / `scanChatStructure` decide provable faults in code (tag balance, duplicate blocks by summary label, tails after the final closing tag, repeated 40+ char lines, field-shape drift against the modal shape once 3+ messages agree). The deep audit hands those findings to the model as **facts**. A model is never asked to eyeball what a parser can decide.
- **`ingestProposals(reply)`** is the one path from a reply to staged cards (dedupe, auto-supersede, review stamping, batching). Both `runGeneration` and `runDeepAudit` use it; a second copy would have drifted within a release.
- **Block parsing:** `findBlock(text, tag)` takes the LAST opening tag that has a closer and prefers JSON-leading content, so prose that merely names a tag doesn't break parsing. Tags: `fetch`, `edits`, `memedits`, `wifetch`, `wiedits`, `think`.
- **Injections** (Director / Editor) are cleared and re-applied on `CHAT_CHANGED`; `[EPISODE_END]` markers are scrubbed from messages and swipes on load / receive / swipe.
- **UI:** a floating, pointer-draggable panel with inline styles (mobile-safe); every mutation prints a receipt; version is stamped in the panel header and console.
- **Target environment:** Android/Termux via a mobile browser — hence inline styles, `position:fixed` sizing, and native `prompt()`/`confirm()` for inputs. The `/cc` slash command and all `cc_*` identifiers are internal and unchanged by the display name.

## Setup

1. Install as a SillyTavern extension: **Extensions -> Install extension**, paste this repo's Git URL.
2. Open the panel: wand menu -> **Chat Assistant**, or the `/cc` slash command.
3. In the gear settings, pick a **Connection Profile** for the assistant (separate from your roleplay model) — required for it to run.
4. Optional: enable the Director / Editor cadence, choose lorebook discovery or legacy injection in Settings, and tune the numbers.

## Notes

- **Numeric settings have three states, not two.** A typed `0`, a cleared box and garbage are different answers and every numeric setting goes through one helper (`numSetting(raw, fallback, lo, hi)`) that keeps them apart and clamps to the bounds the UI declares. `Number(x) || fallback` collapsed all three: a deliberate depth of `0` (inject directly above the reply — the UI declares `min="0"`) was silently rewritten to 3, and *clearing* the stall-timeout or auto-recovery box read as `0`, i.e. **off**, silently disabling the watchdog that stops one hung request from wedging every button.
- **Undo is refusal-first.** A restore happens only when the target is still byte-for-byte what the apply left behind; anything a swipe, a later edit, another extension, or the World Info editor has touched since is skipped and named, never overwritten. If a restore fails outright, the batch is kept — press ↩ Undo again to retry it. **The receipt says what actually happened**: a batch where nothing could be restored reports exactly that instead of printing a success line and then contradicting itself with the skip list one line later.
- Mobile caching is aggressive — after updating, reload the page and confirm the version in the panel header.
- Only the *displayed* name is "Chat Assistant"; the storage key, slash command, and internal identifiers are unchanged, so updating from an older "Continuity Copilot" install keeps all your settings and memory.
