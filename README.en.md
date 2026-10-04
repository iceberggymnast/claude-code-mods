# claude-code-mods

[한국어](README.md) | English

A collection of Claude Code function-hook plugins (mods).

| Mod | What it does |
| --- | --- |
| [state-compact](plugins/state-compact) | Keeps you from paying a large re-caching cost when you step away from a long session |

The text shown at the end of answers and the prompts the mods send to Claude are in Korean.

## state-compact

If you leave a long session open and step away, the prompt cache expires (after 1 hour or 5 minutes). When you come back and send a message, the whole context built up so far is cached again. For an 860K-token session, that one message costs about $6.9.

This mod does two things.

### 1. Wraps up and compacts before the cache expires

If you step away while Claude is waiting on a question, the mod acts just before the cache expires.

1. It asks Claude to write the progress and next steps into a handoff document (e.g. `STATE.md`)
2. When that turn ends, it compacts the conversation

When you return, only the compacted summary needs re-caching, and the details stay in the handoff document.

### 2. Holds back the first message to a long expired session

When you send a message to a session whose cache has already expired and its context is 100K tokens or more, the message is held back once with the cost.

```
state-compact: 캐시가 만료됐습니다. 보내면 컨텍스트 약 861k 토큰을 다시 캐시합니다(약 $6.88).
그대로 보내려면 다시 보내고, 아니면 /compact나 새 세션을 쓰세요.
```

(The cache has expired. Sending will re-cache about 861k tokens of context (about $6.88). Send again to go ahead, or use /compact or a new session.)

The held-back message is put back in the input box. Sending the same message again goes ahead, and slash commands such as `/compact` aren't held back.

### Other features

- **Document update on manual compaction too.** When you type `/compact` or the context passes 85%, Claude is asked to update the handoff document before compacting.
- **End-of-answer marks.** A small box at the end of the last answer shows the compaction and cache state. Press `취소` (cancel) on the scheduled line to cancel it.

  ```
  ◇ 압축 예정                     11:27  취소
  ◆ 압축됨 · 자리 비움             11:27
  ○ 캐시 만료 (컨텍스트 861k)       18:16
  ✕ 압축 실패 · 이유               11:27
  ```

  From the top: compaction scheduled, compacted (while away), cache expired (context size), compaction failed (reason).

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

## How it works

### When pre-expiry compaction is scheduled

It's scheduled when a turn ends and all of the following hold.

| Cache TTL | Context | Compacts at |
| --- | --- | --- |
| 1 hour | 200K tokens or more | 55 min after the last request |
| 5 min | 300K tokens or more | 4 min after the last request |

- Scheduled only when the last answer is waiting for your reply (a question, a request for confirmation). After a finished report you're less likely to return, so compaction would only add cost. This check calls Haiku once per turn, only when the context is over the threshold
- Skipped if there's unsent text in the prompt input, since that means you're there
- Skipped if the machine wakes from sleep past the scheduled time, since the cache has already expired
- The TTL is read from the last response in the session transcript. If it can't be read, nothing is scheduled

### Handoff document update

- Summary instructions passed to a manual `/compact` are kept for the compaction
- Compaction at 85% runs before auto-compaction
- If the document exists at the repository root, it's updated every time regardless of its contents, so a session with no work in progress still gets one update turn
- If the document is tracked by git, Claude is told to commit only that file

### End-of-answer marks

- Scheduled compaction and compaction in progress (`◆ 압축 중…`) appear only on the last answer
- Compacted, cache expired, and compaction failed stay at the end of whichever answer was last at the time and are never removed
- Cache expiry is shown once the TTL has passed since the last request, whatever the token count, unless the session was compacted first. The number in parentheses is the context size at expiry

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
- 5-minute TTL sessions
- The terminal CLI (function hooks were off in that build, so the mod didn't load)
- macOS and Linux
- Whether the mod loads when installed from the marketplace (`claude plugin marketplace add`)

## License

[MIT](LICENSE)
