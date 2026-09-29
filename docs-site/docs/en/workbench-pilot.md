# Workbench pilot contract

This fork is the local Lark/Feishu runtime for Workbench-managed agents. The
hosted Workbench owns pairing and installation orchestration; Botmux owns the
local bot process, conversation routing, CLI session, and delivery behavior.

## Language precedence

Bot-facing product copy and model response guidance resolve in this order:

1. An explicit `lang` on the bot in `bots.json`.
2. The saved machine `lang` in `~/.botmux/config.json`.
3. The fresh-install product default, `en`.

Existing explicit `en` or `zh` values are never rewritten. `botmux lang
--unset` removes only the selected override and exposes the next layer.

The Dashboard browser locale is separate from the model-response locale. It
resolves from the browser's saved Dashboard preference, then the browser
language, then `en`. Changing the Dashboard language does not change a bot's
response language.

English response guidance is a preference, not a prohibition:

> Respond in English by default. Use another language when the user explicitly
> requests it. Preserve quotations, code, identifiers and requested
> translations.

## Workbench conversation preset

Provision a new bot with:

```bash
botmux setup --lang en add --create-app \
  --conversation-preset workbench \
  --cli traecli \
  --default-working-dir /absolute/project/path \
  --allowed-users user@example.com
```

The `workbench` preset is opt-in and one-shot. It records
`conversationPreset: "workbench"` and materializes these existing settings:

```json
{
  "lang": "en",
  "p2pMode": "chat",
  "regularGroupMentionMode": "topic",
  "replyDelivery": "transcript",
  "cotEnabled": false,
  "disableStreamingCard": true,
  "silentTurnReactions": false
}
```

Later explicit edits win. Updating Botmux or revising the preset does not
silently rewrite an existing bot. Dashboard/MOSA onboarding that enables the
critical-scope activation gate applies this preset to a newly created bot;
ordinary onboarding and cloning retain their prior behavior.

## Release provenance and approved versions

This downstream uses GitHub Releases from
`jason-jimenez-bytedance/botmux`. It must never update through the upstream npm
package. Workbench-managed installations must use an exact approved version:

```bash
curl -fsSL https://raw.githubusercontent.com/jason-jimenez-bytedance/botmux/master/install.sh \
  | BOTMUX_REQUIRE_PINNED=1 BOTMUX_VERSION=vX.Y.Z sh
```

The installer requires and verifies the selected artifact's SHA-256. It then
persists the approved version. Operators can inspect or change that policy with:

```bash
botmux distribution status
botmux distribution pin X.Y.Z
botmux distribution unpin
```

When a pin is present, scheduled and Dashboard “latest” checks resolve to that
exact version. Manual installation of a different exact version remains an
operator action. Package-manager updates are rejected because this fork does
not publish a separate npm package.

Every release includes `botmux-manifest.json` with the source repository,
40-character commit, version, tested TRAEx version, platform/libc requirements,
artifact URLs, and verified SHA-256 values.

## Runtime-context boundary

Do not activate multiple Workbench agents by setting only a CLI child's
`TRAE_HOME`. In the current base architecture, daemon-side session discovery,
transcript lookup, and resume resolution read the daemon process's TRAE home.
The complete isolation change therefore belongs in a dependent runtime-context
change that freezes the CLI home on each Botmux session and threads it through
all daemon, worker, adapter, discovery, transcript, sandbox, reset, and project
switch paths.

Until that dependent change is validated, one shared TRAEx home is a pilot
blocker for multiple agents on the same project.

## Automated card evidence

These screenshots are generated from the production Workflow v3 Lark-card JSON
renderer with `locale: "en"`. They are local automated evidence, not screenshots
from a live Lark tenant.

### Success

![English Workbench workflow success card](/img/workbench-card-success.png)

### Empty / waiting

![English Workbench workflow waiting card with no runnable nodes](/img/workbench-card-empty.png)

### Failure

![English Workbench workflow authentication failure card](/img/workbench-card-failure.png)

Regenerate them after a production build with:

```bash
node scripts/capture-workbench-pilot-cards.mjs
```

## Disposable live acceptance

Use a disposable Lark app and devbox. Do not run this against a production bot
fleet.

1. As a repository maintainer, download the complete draft with authenticated
   GitHub CLI access: `gh release download vX.Y.Z --repo
   jason-jimenez-bytedance/botmux --dir candidate`. Verify every checksum from
   inside `candidate/`, copy the correct binary to the disposable devbox, install
   it as `~/.botmux/bin/botmux`, and run `botmux distribution pin X.Y.Z`.
   Verify `botmux distribution status`, `botmux --version`, and the manifest
   commit. The public `install.sh` URL is intentionally unavailable while the
   release remains a draft.
2. Verify `traex --version` and `traex models`. Record the exact TRAEx version.
3. Provision a Workbench bot with the command above and complete QR, permissions,
   event subscription, and publication.
4. DM: send a greeting, a normal question, “why?”, “make it shorter”, a
   correction, and “continue”. Confirm one continuous session and one final
   reply per turn.
5. Group: mention the bot once, continue inside its active topic without another
   mention, send unrelated top-level chatter, and address another person/bot.
   Confirm only intended messages trigger it.
6. Ask for Chinese output and for an English translation of Chinese source text.
   Confirm the explicit language request wins and quoted/code content is preserved.
7. Interrupt a long turn, resume it, disconnect SSH, reconnect, and perform a
   controlled Botmux restart. Confirm the same session resumes without duplicate
   replies.
8. Exercise an expired TRAEx login and an expired Lark authorization. Confirm the
   message names the failed layer and gives the next useful action in English.
9. With the dependent runtime-context change, provision two agents for the same
   repository, give them different notes, restart both, switch projects, and reset
   only one. Confirm neither session, transcript, skill scope, nor note changes
   cross the agent boundary.
10. Capture success, empty, and failure screenshots; record artifact URLs,
    checksums, elapsed time, human interventions, and any unavailable evidence.

Release order: merge reviewed changes, create a new annotated `v*` tag on the
exact approved commit, let the workflow create and verify a complete draft,
download that draft with maintainer credentials, run the disposable-devbox
acceptance above, then have a human publish it with `gh release edit vX.Y.Z
--repo jason-jimenez-bytedance/botmux --draft=false`. After publication,
Workbench hosts may use the pinned `install.sh` command from the release section.
Do not reuse a tag or overwrite an existing release.
