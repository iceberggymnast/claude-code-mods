# claude-code-mods

[한국어](README.md) | English

A collection of Claude Code function-hook plugins (mods).

| Mod | What it does |
| --- | --- |
| [state-compact](plugins/state-compact) | Updates a handoff document before compaction, and compacts just before the prompt cache expires to cut re-caching cost |

The status line text and the prompts the mods send to Claude are in Korean.

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

If the document is tracked by git, Claude is told to commit only that file.

**Compaction before cache expiry.** When a turn ends and all of the following hold, the mod compacts (in the order above) just before the cache expires. Only the summary needs re-caching instead of the whole context, so returning costs less.

| Cache TTL | Context | Compacts at |
| --- | --- | --- |
| 1 hour | 200K tokens or more | 55 min after the last request |
| 5 min | 300K tokens or more | 4 min after the last request |

- Scheduled only when the last answer is waiting for your reply (a question, a request for confirmation). After a finished report you're less likely to return, so compaction would only add cost. This check calls Haiku once per turn, only when the context is over the threshold
- Skipped if there's unsent text in the prompt input, since that means you're there
- Skipped if the machine wakes from sleep past the scheduled time, since the cache has already expired
- The TTL is read from the last response in the session transcript. If it can't be read, nothing is scheduled

**Status line.** Below the prompt it shows that the mod is on (`◇ state-compact · STATE.md`), the scheduled compaction time, compaction in progress (`◆`), and the last failure reason.

### Settings

| Option | Default | Description |
| --- | --- | --- |
| `handoff_file` | (empty) | File to update before compaction, relative to the repository root. If empty, compacts without updating anything |
| `handoff_skip_pattern` | (empty) | If the document matches this regex, there's no work in progress and the update is skipped. Matched per line |

Change them under the plugin's entries in `/config`, or in `pluginConfigs` in `settings.json`. When loaded with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`, the key is `state-compact` or `state-compact@inline`.

```json
{
  "pluginConfigs": {
    "state-compact@inline": {
      "options": {
        "handoff_file": "STATE.md",
        "handoff_skip_pattern": "^# No work in progress"
      }
    }
  }
}
```

### Limitations

- Right after a resume or an app restart the mod doesn't know when the last request was sent, so until you send one request in that session it neither schedules compaction nor updates the document before a manual `/compact`
- There is no command to cancel a scheduled compaction. It's cleared when a new turn starts
- The desktop app doesn't show plugin toasts. Check the status line for failure reasons

### Tested

Tested on the Windows desktop app: manual `/compact` → document update → compaction (including summary instructions), the status line, and scheduling compaction in a 1-hour TTL session. Not yet tested:

- Whether a scheduled compaction actually runs
- Compaction at 85% context
- 5-minute TTL sessions
- The terminal CLI (function hooks were off in that build, so the mod didn't load)
- macOS and Linux
- Whether the mod loads when installed from the marketplace (`claude plugin marketplace add`)

## License

[MIT](LICENSE)
