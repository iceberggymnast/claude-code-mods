# claude-code-mods

[한국어](README.md) | English

A collection of Claude Code function-hook plugins (mods).

| Mod | What it does |
| --- | --- |
| [state-compact](plugins/state-compact) | Updates a handoff document before compaction, and cuts re-caching cost by compacting just before the prompt cache expires and warning before the first message to an expired session |

The text shown at the end of answers and the prompts the mods send to Claude are in Korean.

## Install

You need a Claude Code build that supports function-hook plugins. Clone the repository and point Claude Code at the mod folder.

```bash
git clone https://github.com/iceberggymnast/claude-code-mods.git
```

In the terminal, pass the folder at launch.

```bash
claude --plugin-dir <repo>/plugins/state-compact
```

Where you can't pass launch flags, such as the desktop app, add it to `env` in `~/.claude/settings.json`. Separate multiple folders with the path-list separator (`;` on Windows, `:` elsewhere).

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "<repo>/plugins/state-compact"
  }
}
```

To check the install, run `claude plugin validate <repo>/plugins/state-compact`.

## state-compact

Compaction replaces the conversation's details with a summary, which blurs where the work stands. And if the prompt cache expires while you're away, the first request after you return re-caches the whole context. This mod steps in at both points.

**Update before compaction.** In these cases, Claude is asked to update the handoff document (e.g. `STATE.md`) first, and compaction runs when that turn ends.

- Manual `/compact`. Any summary instructions you pass are kept
- Context passes 85% of the window. This runs before auto-compaction

If the document exists at the repository root, it's updated every time regardless of its contents, so a session with no work in progress still gets one update turn. If the document is tracked by git, Claude is told to commit only that file.

**Compaction before cache expiry.** When a turn ends and all of the following hold, the mod compacts (in the order above) just before the cache expires. Only the summary needs re-caching instead of the whole context, so returning costs less.

| Cache TTL | Context | Compacts at |
| --- | --- | --- |
| 1 hour | 200K tokens or more | 55 min after the last request |
| 5 min | 300K tokens or more | 4 min after the last request |

- Scheduled only when the last answer is waiting for your reply (a question, a request for confirmation). After a finished report you're less likely to return, so compaction would only add cost. This check calls Haiku once per turn, only when the context is over the threshold
- Skipped if there's unsent text in the prompt input, since that means you're there
- Skipped if the machine wakes from sleep past the scheduled time, since the cache has already expired
- The TTL is read from the last response in the session transcript. If it can't be read, nothing is scheduled

**End-of-answer marks.** A small box at the end of the last answer shows the scheduled compaction time (`◇ 15:52 압축 예정`) and compaction in progress (`◆ 압축 중…`). Compacted (`◆ 15:17 압축됨 · 자리 비움`), cache expired (`○ 16:12 캐시 만료`), and compaction failed (`✕ 15:17 압축 실패 · reason`) stay at the end of whichever answer was last at the time and are never removed. Cache expiry is shown once the TTL has passed since the last request, whatever the token count, unless the session was compacted first.

**First message to an expired session.** When you reopen a session whose cache has expired and its context is 100K tokens or more, your first message is held back once with the number of tokens it would re-cache and the estimated cost. Send it again to go ahead. Slash commands (`/compact` and the like) aren't held back.

### Settings

| Option | Default | Description |
| --- | --- | --- |
| `handoff_file` | (empty) | File to update before compaction, relative to the repository root. If empty, compacts without updating anything |

Change them under the plugin's entries in `/config`, or in `pluginConfigs` in `settings.json`. When loaded with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`, the key is `state-compact` or `state-compact@inline`.

```json
{
  "pluginConfigs": {
    "state-compact@inline": {
      "options": {
        "handoff_file": "STATE.md"
      }
    }
  }
}
```

### Limitations

- Right after a resume or an app restart the mod doesn't know when the last request was sent, so until you send one request in that session it neither schedules compaction nor updates the document before a manual `/compact`. The cache-expired mark is based on the last response time instead: if the cache expired while the app was closed, the mark is added to the previous last answer when you next send a message in that session (the desktop app doesn't run the mod just for opening a session from the list), and its time is later than the real expiry by however long that response took
- There is no command to cancel a scheduled compaction. It's cleared when a new turn starts
- The desktop app doesn't show plugin toasts. Check the end-of-answer marks for failure reasons
- A manual `/compact` leaves two `/compact` bubbles in the conversation. The first is the one you typed (held back for the document update); the second is the mod running it again once the update is done

### Tested

Tested on the Windows desktop app: manual `/compact` → document update → compaction (including summary instructions), pre-expiry compaction in a 1-hour TTL session (it ran 55 minutes after the last request), and the end-of-answer mark on a manual `/compact` going from `◆ 압축 중…` to `◆ 15:35 압축됨 · 수동`, the `○ 18:16 캐시 만료` mark on a session whose TTL ran out while another session was in view, and holding back the first message to an expired 860K-token session with a warning and putting the message back in the input box. Not yet tested:

- Updating the document before a pre-expiry compaction (the compaction observed went straight to compacting without an update)
- The scheduled and failed end-of-answer marks, and whether marks survive an app restart
- Whether a held-back first message goes through when sent again, and whether a cache expiry that passed while the app was closed is added to the previous answer of a reopened session
- Compaction at 85% context
- 5-minute TTL sessions
- The terminal CLI (function hooks were off in that build, so the mod didn't load)
- macOS and Linux
- Whether the mod loads when installed from the marketplace (`claude plugin marketplace add`)

## License

[MIT](LICENSE)
