# claude-code-mods

[한국어](README.md) | English

A collection of Claude Code function-hook plugins (mods).

| Mod | What it does |
| --- | --- |
| [state-compact](plugins/state-compact) | Keeps you from paying a large re-caching cost when you step away from a long session |
| [token-speedometer](plugins/token-speedometer) | Shows how fast the answer is being output as a racing-game speedometer above the prompt |

The text the mods show and the instructions they send to Claude are in Korean by default. For state-compact, set `language` to `en` (see [Settings](#settings)). The examples below show the English text.

## state-compact

If you leave a long session open and step away, the prompt cache expires (after 1 hour or 5 minutes). When you come back and send a message, the whole context built up so far is cached again. For an 860K-token session, that one message costs about $6.9.

This mod does two things.

### 1. Wraps up and compacts before the cache expires

If you step away while Claude is waiting on a question or on background work (a subagent, etc.), the mod acts just before the cache expires.

1. It asks Claude to write the progress and next steps into a handoff document (e.g. `STATE.md`)
2. When that turn ends, it compacts the conversation

When you return, only the compacted summary needs re-caching, and the details stay in the handoff document.

### 2. Holds back the first message to a long expired session

When you send a message to a session whose cache has already expired and its context is 100K tokens or more, the message is held back once with the cost.

```
state-compact: The cache has expired. Sending will re-cache about 861k tokens of context (about $6.88).
Send again to go ahead, or use /compact or a new session.
```

The held-back message is put back in the input box. Sending the same message again goes ahead, and slash commands such as `/compact` aren't held back.

### Other features

- **Document update on manual compaction too.** When you type `/compact` or the context passes 85%, Claude is asked to update the handoff document before compacting.
- **End-of-answer marks.** A small box at the end of the last answer shows the compaction and cache state. Press `Cancel` on the scheduled line to cancel it.

  ```
  ◇ Compaction scheduled          11:27  Cancel
  ◆ Compacted · away              11:27
  ○ Cache expired (context 861k)  18:16
  ✕ Compaction failed · reason    11:27
  ```

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

## Settings

| Option | Default | Description |
| --- | --- | --- |
| `handoff_file` | (empty) | File to update before compaction, relative to the repository root. If empty, compacts without updating anything |
| `language` | `ko` | Language of the end-of-answer marks, the warning, and the instructions sent to Claude. `ko` or `en` |

Change them under the plugin's entries in `/config`, or in `pluginConfigs` in `settings.json`. When loaded with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`, the key is `state-compact` or `state-compact@inline`.

```json
{
  "pluginConfigs": {
    "state-compact@inline": {
      "options": {
        "handoff_file": "STATE.md",
        "language": "en"
      }
    }
  }
}
```

## How it works

### When pre-expiry compaction is scheduled

It's scheduled when a turn ends and all of the following hold.

| Cache TTL | Context | Compacts at |
| --- | --- | --- |
| 1 hour | 200K tokens or more | 55 min after the last request |
| 5 min | 300K tokens or more | 4 min after the last request |

- Scheduled only when the last answer is waiting for your reply (a question, a request for confirmation), or when background work (a subagent, a background shell, etc.) is still running as the turn ends, since its completion wakes the session again. After a finished report you're less likely to return, so compaction would only add cost. Whether the answer waits for your reply is checked with Haiku, once per turn, only when there's no background work and the context is over the threshold
- Skipped if there's unsent text in the prompt input, since that means you're there
- Skipped if the machine wakes from sleep past the scheduled time, since the cache has already expired
- The TTL is read from the last response in the session transcript. If it can't be read, nothing is scheduled

### Handoff document update

- Summary instructions passed to a manual `/compact` are kept for the compaction
- Compaction at 85% runs before auto-compaction
- If the document exists at the repository root, it's updated every time regardless of its contents, so a session with no work in progress still gets one update turn
- If the document is tracked by git, Claude is told to commit only that file

### End-of-answer marks

- Scheduled compaction and compaction in progress (`◆ Compacting…`) appear only on the last answer
- Compacted, cache expired, and compaction failed stay at the end of whichever answer was last at the time and are never removed
- Cache expiry is shown once the TTL has passed since the last request, whatever the token count, unless the session was compacted first. The number in parentheses is the context size at expiry

### Decision log

Why pre-expiry compaction wasn't scheduled, or was skipped, never shows up in the session transcript. So each decision made when a turn ends and at the scheduled time is written as one line to `<session id>.state-compact.log`, next to the transcript (`~/.claude/projects/<project>/<session id>.jsonl`). It holds the TTL, context token count, number of background tasks, the Haiku verdict and how long it took, and the reason for skipping, but no answer text. Past 250K characters the oldest lines are dropped.

## Limitations

- Right after a resume or an app restart the mod doesn't know when the last request was sent, so until you send one request in that session it neither schedules compaction nor updates the document before a manual `/compact`. The cache-expired mark is based on the last response time instead: if the cache expired while the app was closed, the mark is added to the previous last answer when you next send a message in that session (the desktop app doesn't run the mod just for opening a session from the list), and its time is later than the real expiry by however long that response took
- The desktop app doesn't show plugin toasts. Check the end-of-answer marks for failure reasons
- A manual `/compact` leaves two `/compact` bubbles in the conversation. The first is the one you typed (held back for the document update); the second is the mod running it again once the update is done

## Tested

Tested on the Windows desktop app: manual `/compact` → document update → compaction (including summary instructions), pre-expiry compaction in a 1-hour TTL session (it ran 55 minutes after the last request), and the end-of-answer mark on a manual `/compact` going from `◆ 압축 중…` to `◆ 15:35 압축됨 · 수동`, the `○ 18:16 캐시 만료` mark on a session whose TTL ran out while another session was in view, and holding back the first message to an expired 860K-token session with a warning and putting the message back in the input box. Not yet tested:

- Updating the document before a pre-expiry compaction (the compaction observed went straight to compacting without an update)
- The scheduled end-of-answer mark and its cancel button, the failed mark, and whether marks survive an app restart
- Whether a held-back first message goes through when sent again, and whether a cache expiry that passed while the app was closed is added to the previous answer of a reopened session
- Compaction at 85% context
- The text and instructions with `language` set to `en`
- 5-minute TTL sessions
- The terminal CLI (function hooks were off in that build, so the mod didn't load)
- macOS and Linux
- Whether the mod loads when installed from the marketplace (`claude plugin marketplace add`)

## token-speedometer

Shows how fast the answer is being output (tokens per second) as a racing-game speedometer above the prompt.

- **Big number**: the current speed. Leading zeros are drawn dim
- **Bar**: 0–200 tok/s, red from 160. Three segments stay lit even at 0. The triangle marks this turn's top speed
- **Gear**: which model request of this turn it is (green). `N` while thinking or running tools, `P` once the turn ends (red)
- **Lamps**: `REQ` waiting for a response · `THK` thinking · `OUT` outputting · `TOOL` running tools
- **AVG · TOP · LAUNCH**: the average of finished responses, this turn's top speed, and the time until the first chunk arrived

When the turn ends, the number and the bar fall to 0 and the gear stays at `P`. Install it as in [Install](#install), giving the folder `<repo>/plugins/token-speedometer`. It has no settings. The speedometer's labels are in English; the terminal line and the image's alt text are in Korean.

### How speed is measured

So the numbers can be compared with model comparison charts, speed is measured the way [Artificial Analysis](https://artificialanalysis.ai/methodology/performance-benchmarking) measures output speed.

- Tokens are counted with OpenAI's `o200k_base`, not Claude's tokenizer. The answer shown on screen (text and tool input) is estimated by a per-character cost by character type: Hangul 0.90, ASCII letters and digits 0.25, whitespace 0.10, ASCII symbols 0.61, anything else 1.0 tokens per character. These were fitted against `tiktoken` on 6,000 answers from Claude Code session logs; on 6,000 held-out answers the total error was -0.6%, and within ±4% when split by the share of Hangul
- Thinking is left out; only the time the answer is being output counts. While thinking or running tools, the number falls toward 0
- The current speed is taken over the last second. It updates 10 times a second and moves 30% of the way each time, so the number steps up and down rather than jumping
- Subagent responses are not counted

Artificial Analysis leaves out the first 20% of answer chunks; this mod measures from the start. Serving conditions and effort differ too, so the numbers won't match the chart exactly.

### Limitations

- The desktop app redraws a plugin's image at most 10 times a second, so motion between updates can't be drawn. SVG animation only runs in interactive images (`isInteractive`), which flicker and shrink on every update, so they aren't used
- In the terminal it shows a text bar and the numbers on one line instead of the image
- Light and dark mode are told apart by `prefers-color-scheme` inside the image

### Tested

Tested on the Windows desktop app in light mode: the speedometer, phase and gear changes, slowing down as soon as output ends, falling to 0 and staying at `P` after the turn ends, and shrinking in proportion when the window is narrowed. Not yet tested:

- Whether the colors change in dark mode
- The terminal CLI display
- macOS and Linux

## License

[MIT](LICENSE)
