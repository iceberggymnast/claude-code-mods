import type { EngineInterface, Register } from 'claude-code'

// 만료 전 압축의 TTL별 기준. 값은 입력 단가 단위로 "돌아왔을 때 아끼는 양 > 0"에서 정했다.
//  - minTokens: 이보다 작으면 압축하지 않는다. 1시간은 다시 쓰기가 2배라 1.8 × 컨텍스트 - 19만,
//    5분은 1.25배라 1.15 × 컨텍스트 - 14만이 남는다. 5분은 자리에 있는데 압축할 일도 잦아 기준을 더 높였다.
//  - compactAfterMs: 마지막 요청 시작 후 이만큼 지나면 압축을 시작한다. 만료 전에 첫 요청이 나가야 한다.
//  - lateLimitMs: 타이머가 이보다 늦게 돌면(절전에서 깨어남) 캐시가 이미 만료된 것으로 보고 건너뛴다.
const IDLE_RULES = {
  '1h': { minTokens: 200_000, compactAfterMs: 55 * 60_000, lateLimitMs: 58 * 60_000 },
  '5m': { minTokens: 300_000, compactAfterMs: 4 * 60_000, lateLimitMs: 4.5 * 60_000 },
} as const
// 컨텍스트가 창의 이 비율을 넘기면 자동 압축이 오기 전에 handoff 문서 반영 후 먼저 압축한다.
const PREEMPT_PERCENT = 85
const ONE_HOUR_MS = 60 * 60_000
const FIVE_MIN_MS = 5 * 60_000
// 수동 /compact 때 캐시가 살아 있다고 보는 여유. 이보다 만료에 가까우면 반영 턴을 넣지 않는다.
const CACHE_MARGIN_MS = 2 * 60_000
// 응답 대기 판정에 넘기는 마지막 답변의 길이.
const CLASSIFY_TAIL_CHARS = 4000
// 압축 직전 턴이 끝난 뒤 압축을 부르기까지의 간격. 턴이 도는 동안 compact는 거절된다.
const AFTER_TURN_MS = 1000
// TTL을 찾으려고 세션 기록 파일 끝에서 읽는 바이트 수.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024
// 답 끝 표시를 남겨 두는 답의 수. 넘으면 오래된 것부터 지운다($.store는 4 MiB가 한도다).
const MAX_MARKED_REPLIES = 200
// 마지막 답을 찾을 때 비교하는 끝부분 길이. 화면에 그리는 텍스트는 앞부분이 원문과 다를 수 있다.
const MATCH_TAIL_CHARS = 80
// 캐시가 만료된 세션을 다시 열어 첫 메시지를 보낼 때, 컨텍스트가 이 이상이면 한 번 막고 경고한다.
const EXPIRED_WARN_TOKENS = 100_000

// 화면에 내는 글자와 Claude에게 보내는 지시. 설정 language로 고른다.
const KO = {
  compacting: '◆ 압축 중…',
  now: '지금',
  scheduled: '◇ 압축 예정',
  cancel: '취소',
  compacted: (detail?: string) => `◆ 압축됨 · ${detail}`,
  expired: (tokens?: number) => `○ 캐시 만료${tokens === undefined ? '' : ` (컨텍스트 ${Math.round(tokens / 1000)}k)`}`,
  failed: (detail?: string) => `✕ 압축 실패 · ${detail}`,
  auto: '자동',
  manual: '수동',
  away: '자리 비움',
  contextLabel: (percent?: number) => `컨텍스트 ${percent}%`,
  contextReason: (percent?: number) => `컨텍스트가 ${percent}%까지 찼다.`,
  manualReason: '/compact를 실행했다.',
  awayReason: '자리를 비운 사이 프롬프트 캐시가 곧 만료된다.',
  compactAsTurn: '/compact 명령이 압축 대신 턴으로 처리됐다',
  handoffUnfinished: (file: string) => `${file} 반영이 끝나지 않아 압축하지 않았다`,
  compactSkipped: (skip: string) => `압축이 취소됐다 (${skip})`,
  commandNoCompact: (out?: string) => `/compact 명령이 압축하지 않았다 (${out ?? '출력 없음'})`,
  commandFailed: (err: string) => `/compact 명령을 실행하지 못했다 (${err})`,
  compactFailed: (err: string) => `압축하지 못했다 (${err})`,
  handoffFirst: (file: string) => `state-compact: ${file}을 먼저 반영한 뒤 압축합니다`,
  expiredWarn: (tokens: number, usd: number | undefined, isFilled: boolean) =>
    `state-compact: 캐시가 만료됐습니다. 보내면 컨텍스트 약 ${Math.round(tokens / 1000)}k 토큰을 다시 캐시합니다` +
    `${usd === undefined ? '' : `(약 $${usd.toFixed(2)})`}. ` +
    `그대로 보내려면 다시 보내고, 아니면 /compact나 새 세션을 쓰세요.${isFilled ? '' : ' 보낸 메시지는 입력창에 되돌리지 못했습니다.'}`,
  handoffPrompt: (path: string, file: string, isTracked: boolean, reason: string) =>
    [
      `[state-compact] ${reason} 곧 대화를 압축한다. 압축하면 지금 대화의 세부 내용은 요약으로 바뀐다.`,
      `압축 전에 ${path}에 지금까지 진행한 내용과 다음에 할 일을 반영하라.`,
      isTracked
        ? `${file}은 git이 추적하는 파일이다. \`git commit -- ${file}\` 형식으로 이 파일만 커밋하라. 다른 변경은 커밋에 넣지 마라.`
        : `${file}은 git이 추적하지 않는 파일이다. 커밋하지 마라.`,
      '그 밖의 작업은 하지 말고, 끝나면 무엇을 고쳤는지 한 줄로만 답하라.',
    ].join('\n'),
}
const EN: typeof KO = {
  compacting: '◆ Compacting…',
  now: 'now',
  scheduled: '◇ Compaction scheduled',
  cancel: 'Cancel',
  compacted: detail => `◆ Compacted · ${detail}`,
  expired: tokens => `○ Cache expired${tokens === undefined ? '' : ` (context ${Math.round(tokens / 1000)}k)`}`,
  failed: detail => `✕ Compaction failed · ${detail}`,
  auto: 'auto',
  manual: 'manual',
  away: 'away',
  contextLabel: percent => `context ${percent}%`,
  contextReason: percent => `Context has reached ${percent}%.`,
  manualReason: '/compact was run.',
  awayReason: 'The prompt cache is about to expire while the user is away.',
  compactAsTurn: '/compact ran as a turn instead of compacting',
  handoffUnfinished: file => `not compacted because the ${file} update didn't finish`,
  compactSkipped: skip => `compaction was cancelled (${skip})`,
  commandNoCompact: out => `/compact didn't compact (${out ?? 'no output'})`,
  commandFailed: err => `couldn't run /compact (${err})`,
  compactFailed: err => `couldn't compact (${err})`,
  handoffFirst: file => `state-compact: updating ${file} before compacting`,
  expiredWarn: (tokens, usd, isFilled) =>
    `state-compact: The cache has expired. Sending will re-cache about ${Math.round(tokens / 1000)}k tokens of context` +
    `${usd === undefined ? '' : ` (about $${usd.toFixed(2)})`}. ` +
    `Send again to go ahead, or use /compact or a new session.${isFilled ? '' : " Couldn't put your message back in the input box."}`,
  handoffPrompt: (path, file, isTracked, reason) =>
    [
      `[state-compact] ${reason} The conversation will be compacted soon. Compaction replaces the details of this conversation with a summary.`,
      `Before that, update ${path} with the progress so far and what to do next.`,
      isTracked
        ? `${file} is tracked by git. Commit only this file, as \`git commit -- ${file}\`. Don't include other changes in the commit.`
        : `${file} isn't tracked by git. Don't commit it.`,
      'Do nothing else, and when done reply in one line saying what you changed.',
    ].join('\n'),
}

const CLASSIFY_SYSTEM =
  'You label the last message an AI coding assistant sent to its user. Reply with one word. ' +
  "WAIT: the message asks the user a question, asks for a decision or confirmation, or otherwise needs the user's reply before the work can go on. " +
  'DONE: the message reports finished work or answers a question and needs no reply.'

// 세션 기록 파일의 끝부분을 출력한다. 기록 파일은 수 MB까지 커지므로 끝에서만 읽는다.
const TAIL_POWERSHELL =
  '$f=[IO.File]::Open($env:STATE_COMPACT_TRANSCRIPT,"Open","Read","ReadWrite");' +
  `$n=[Math]::Min($f.Length,${TRANSCRIPT_TAIL_BYTES});$null=$f.Seek(-$n,"End");` +
  '$b=New-Object byte[] $n;$null=$f.Read($b,0,$n);$f.Close();' +
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))'

type Ttl = '1h' | '5m'
type HandoffDoc = { path: string; isTracked: boolean }
// 답 끝에 남기는 기록. 그 답에 붙은 채로 지우지 않는다.
// tokens는 캐시 만료 때의 컨텍스트 크기다.
type Mark = { kind: 'compacted' | 'expired' | 'failed'; at: number; detail?: string; tokens?: number }

// 이 프로세스에서 마지막으로 보낸 메인 요청의 시작 시각. resume·재시작 직후에는 없으므로
// 그때는 만료 전 압축도, 수동 압축 앞의 반영 턴도 하지 않는다.
let lastRequestAt: number | undefined
let transcriptPath: string | undefined
let idleTimer: { cancel: () => void } | undefined
let idleAt: number | undefined
let idleLateAt: number | undefined
let expiryTimer: { cancel: () => void } | undefined
// handoff 문서 반영 → 압축 순서가 진행 중이다.
let isBusy = false
// 진행 중인 압축을 답 끝에 적을 때의 이유. 플러그인이 시작한 압축에만 있다.
let compactLabel: string | undefined
let isAwaitingHandoffTurn = false
let handoffTurnId: string | undefined
let pendingInstructions: string | undefined
// SDK 세션에서 /compact 명령을 실행하고 그 압축이 지나가기를 기다리는 중이다.
let isAwaitingCompactPrompt = false
// 사용자 설정(userConfig). handoffFile이 비어 있으면 문서 반영 없이 압축만 한다.
let handoffFile = ''
let msg = KO
// 답(메시지 id)별 기록. $.store에 같이 써서 앱을 다시 켜도 남긴다.
let marks = new Map<string, Mark[]>()
// 마지막 답의 텍스트와, 그 답을 그리는 블록의 id. 진행 상태(압축 예정·압축 중)는 이 블록에만 붙인다.
let lastAnswer: string | undefined
let lastId: string | undefined
// 마지막 답 블록을 찾기 전에 생긴 기록. 찾으면 그 답에 붙인다.
let pendingMarks: Mark[] = []
// 다시 연 세션의 캐시가 만료돼 첫 메시지가 컨텍스트 전체를 다시 캐시한다. 경고하거나 턴이 시작되면 지운다.
let expiredResume: { tokens: number; usd?: number } | undefined

export const register: Register = (on, options) => {
  handoffFile = String(options.handoff_file ?? '').trim()
  msg = options.language === 'en' ? EN : KO

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('marks')
    if (saved && typeof saved === 'object') marks = new Map(Object.entries(saved as Record<string, Mark[]>))
    redraw($)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    // 마지막 답이 정해진 뒤 처음 그려지는 블록 중 끝부분이 같은 것을 그 답으로 본다.
    // 그린 순서로 고르면 위로 스크롤해 처음 그려진 옛 블록이 잡힌다.
    if (lastId === undefined && lastAnswer !== undefined && tail(e.props.text) !== '' && tail(e.props.text) === tail(lastAnswer)) {
      lastId = e.requestId
      for (const mark of pendingMarks.splice(0)) void addMark($, mark)
    }
    // 한 줄에 왼쪽은 항목, 오른쪽은 시각.
    const rows = (marks.get(e.requestId) ?? []).map(markRow)
    const isLast = e.requestId === lastId
    if (isLast && isBusy) rows.push([msg.compacting, msg.now])
    // 압축 예정 줄에는 예약을 푸는 버튼을 시각 오른쪽에 붙인다.
    const scheduledAt = isLast && !isBusy ? idleAt : undefined
    if (rows.length === 0 && scheduledAt === undefined) return drawn
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="column" width="100%" borderStyle="round" borderDimColor paddingX={1}>
          {rows.map(([item, time]) => (
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor>{item}</Text>
              <Text dimColor>{time}</Text>
            </Box>
          ))}
          {scheduledAt !== undefined && (
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor>{msg.scheduled}</Text>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{hhmm(scheduledAt)}</Text>
                <Button key="cancel-idle" plain dimColor onPress={() => { cancelIdle(); redraw($) }}>{msg.cancel}</Button>
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  // 앱을 재시작하거나 세션을 다시 열었다. 꺼져 있던 동안 지난 캐시 만료를 남긴다.
  on('classic.SessionStart', async ($, e, next) => {
    transcriptPath = e.transcript_path
    if (e.source === 'resume' && e.prompt_cache_likely_expired && (e.context_tokens ?? 0) >= EXPIRED_WARN_TOKENS) {
      expiredResume = { tokens: e.context_tokens ?? 0, usd: e.estimated_cache_write_usd }
    }
    const result = await next(e)
    if (e.source === 'resume' && e.seconds_since_last_response !== undefined) {
      void restoreExpiry($, e.seconds_since_last_response, e.context_tokens)
    }
    return result
  })

  // 사용자가 쓴 첫 메시지만 막는다. 명령(/compact 등)은 그대로 보낸다. 같은 메시지를 다시 보내면 통과한다.
  on('prompt.submit', async ($, e, next) => {
    const warn = expiredResume
    const isUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (!warn || !isUser || e.text.trimStart().startsWith('/')) return next(e)
    expiredResume = undefined
    const { isFilled } = await $.prompt.fill({ text: e.text })
    return { drop: msg.expiredWarn(warn.tokens, warn.usd, isFilled) }
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    transcriptPath = e.transcript_path
    return next(e)
  })

  on('classic.Stop', ($, e, next) => {
    transcriptPath = e.transcript_path
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    lastRequestAt = await $.clock.now()
    return yield* next(e)
  })

  on('turn.start', ($, e, next) => {
    expiredResume = undefined
    cancelIdle()
    cancelExpiry()
    if (isAwaitingHandoffTurn) {
      isAwaitingHandoffTurn = false
      handoffTurnId = e.turnId
    }
    redraw($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    if (e.answer.trim()) {
      lastAnswer = e.answer
      lastId = undefined
      redraw($)
    }

    // 실행한 /compact가 압축 없이 턴으로 끝났다.
    if (isAwaitingCompactPrompt) {
      finish($)
      notifyFailure($, msg.compactAsTurn)
      return result
    }

    if (handoffTurnId !== undefined && e.turnId === handoffTurnId) {
      handoffTurnId = undefined
      if (e.reason === 'answer') {
        $.clock.after(AFTER_TURN_MS, () => void compactNow($))
      } else {
        finish($)
        notifyFailure($, msg.handoffUnfinished(handoffFile))
      }
      return result
    }

    if (isBusy) return result
    // 중단된 턴도 캐시는 남으므로 만료 표시만 예약한다(토큰 0이면 만료 전 압축은 건너뛴다).
    if (e.reason !== 'answer') {
      void scheduleTimers($, 0, '')
      return result
    }

    const { context } = await $.session.usage()
    if ((context.percent ?? 0) >= PREEMPT_PERCENT) {
      $.clock.after(AFTER_TURN_MS, () => void begin($, msg.contextReason(context.percent), msg.contextLabel(context.percent)))
      return result
    }
    // 기록 파일 읽기와 응답 대기 판정에 몇 초가 걸린다. 턴 종료를 붙잡지 않도록 기다리지 않는다.
    void scheduleTimers($, context.tokens ?? 0, e.answer)
    return result
  })

  // 메인 대화의 압축이 끝나면 그 시점의 마지막 답 끝에 남긴다. 어떤 경로로 압축됐든 같다.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'precompute') return next(e)
    const label = compactLabel ?? (e.trigger === 'auto' ? msg.auto : msg.manual)
    const r = await next(e)
    if (r.skip) return r
    // 압축하면서 캐시를 새로 만들었으므로 이전 요청 기준의 만료 표시와 경고는 맞지 않다.
    cancelExpiry()
    expiredResume = undefined
    await addMark($, { kind: 'compacted', at: await $.clock.now(), detail: label })
    return r
  })

  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    if (!e.agentId && isAwaitingCompactPrompt) {
      try {
        return await next(e)
      } finally {
        finish($)
      }
    }
    if (e.agentId || isBusy) return next(e)
    // TTL을 확인하지 못하면 짧은 쪽으로 본다.
    const ttlMs = (await readTtl($)) === '1h' ? ONE_HOUR_MS : FIVE_MIN_MS
    // resume한 세션이나 오래 쉰 세션은 캐시가 이미 없다. 반영 턴을 넣으면 전체를 한 번 더
    // 캐시하게 되므로 그대로 압축한다.
    if (lastRequestAt === undefined || (await $.clock.now()) - lastRequestAt > ttlMs - CACHE_MARGIN_MS) {
      return next(e)
    }
    if (!(await findHandoffDoc($))) return next(e)
    $.clock.after(AFTER_TURN_MS, () => void begin($, msg.manualReason, msg.manual, e.instructions))
    return { skip: msg.handoffFirst(handoffFile) }
  })
}

// 캐시 만료 표시는 매 턴 예약한다. 만료 전 압축은 사용자의 답을 기다리는 턴에서만 예약한다.
// 끝난 보고면 돌아올 가능성이 낮아 압축 비용만 남는다.
async function scheduleTimers($: EngineInterface, tokens: number, answer: string) {
  cancelIdle()
  cancelExpiry()
  redraw($)
  const requestAt = lastRequestAt
  if (requestAt === undefined) return
  // 마지막 응답이 실제로 캐시된 TTL. 확인하지 못하면 예약하지 않는다.
  const ttl = await readTtl($)
  if (!ttl || lastRequestAt !== requestAt || isBusy) return
  const expireAt = requestAt + (ttl === '1h' ? ONE_HOUR_MS : FIVE_MIN_MS)
  expiryTimer = $.clock.after(Math.max(0, expireAt - (await $.clock.now())), () => void onExpire($, expireAt))
  const rule = IDLE_RULES[ttl]
  if (tokens < rule.minTokens) return
  if (!(await isAwaitingReply($, answer))) return
  // 판정하는 몇 초 사이에 새 턴이 시작됐거나 압축이 진행 중이면 이 예약은 낡았다.
  if (lastRequestAt !== requestAt || isBusy) return
  const wait = rule.compactAfterMs - ((await $.clock.now()) - requestAt)
  if (wait <= 0) return
  idleAt = requestAt + rule.compactAfterMs
  idleLateAt = requestAt + rule.lateLimitMs
  idleTimer = $.clock.after(wait, () => void onIdle($))
  redraw($)
}

async function onIdle($: EngineInterface) {
  const lateAt = idleLateAt
  idleTimer = undefined
  idleAt = undefined
  idleLateAt = undefined
  redraw($)
  if (isBusy || lateAt === undefined) return
  if ((await $.clock.now()) > lateAt) return
  // 입력창에 쓰던 글이 있으면 자리에 있는 것이다.
  if ((await $.prompt.read()).text.trim() !== '') return
  await begin($, msg.awayReason, msg.away)
}

async function onExpire($: EngineInterface, expireAt: number) {
  expiryTimer = undefined
  if (isBusy) return
  const { context } = await $.session.usage()
  await addMark($, { kind: 'expired', at: expireAt, tokens: context.tokens })
}

// 다시 연 세션의 마지막 응답 기준으로 만료를 남긴다. 이미 지났으면 바로, 아니면 예약한다.
// 데스크톱 앱은 세션을 열기만 해서는 프로세스를 띄우지 않아, 대개 새 메시지를 보낼 때 여기에 온다.
// 마지막 요청 시각은 모르므로 응답 시각을 쓴다. 표시 시각은 실제 만료보다 응답 시간만큼 늦다.
async function restoreExpiry($: EngineInterface, secondsSinceResponse: number, tokens: number | undefined) {
  const respondedAt = (await $.clock.now()) - secondsSinceResponse * 1000
  const ttl = await readTtl($)
  if (!ttl) return
  // 꺼지기 전에 만료나 압축을 이미 남겼으면 다시 남기지 않는다.
  const saved = (await $.store.get('marks')) as Record<string, Mark[]> | undefined
  if (Object.values(saved ?? {}).flat().some(m => m.kind !== 'failed' && m.at >= respondedAt)) return
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return
  // 새 메시지의 답이 아직 안 왔으면 다시 열기 전의 마지막 답에 붙인다.
  if (lastAnswer === undefined) {
    const answers = messages.filter(m => m.role === 'assistant' && m.text.trim())
    lastAnswer = answers[answers.length - 1]?.text
    redraw($)
  }
  const expireAt = respondedAt + (ttl === '1h' ? ONE_HOUR_MS : FIVE_MIN_MS)
  const wait = expireAt - (await $.clock.now())
  if (wait <= 0) {
    await addMark($, { kind: 'expired', at: expireAt, tokens })
    return
  }
  // 그 사이 새 요청이 나갔으면 그 턴이 예약한다.
  if (lastRequestAt !== undefined) return
  cancelExpiry()
  expiryTimer = $.clock.after(wait, () => void onExpire($, expireAt))
}

function cancelIdle() {
  idleTimer?.cancel()
  idleTimer = undefined
  idleAt = undefined
  idleLateAt = undefined
}

function cancelExpiry() {
  expiryTimer?.cancel()
  expiryTimer = undefined
}

async function begin($: EngineInterface, reason: string, label: string, instructions?: string) {
  if (isBusy) return
  isBusy = true
  compactLabel = label
  cancelIdle()
  cancelExpiry()
  redraw($)
  pendingInstructions = instructions
  const doc = await findHandoffDoc($)
  if (!doc) {
    await compactNow($)
    return
  }
  isAwaitingHandoffTurn = true
  await $.prompt.submit({ text: msg.handoffPrompt(doc.path, handoffFile, doc.isTracked, reason) })
}

async function compactNow($: EngineInterface) {
  try {
    const r = await $.session.compact(pendingInstructions ? { instructions: pendingInstructions } : undefined)
    if (r.skip) notifyFailure($, msg.compactSkipped(r.skip))
  } catch (err) {
    // SDK 세션(데스크톱 앱 등)은 플러그인의 압축 호출을 거절한다. /compact를 프롬프트로 넣어도
    // 큐에 들어가지 않았으므로 슬래시 명령으로 실행한다.
    if (String(err).includes('headless')) {
      isAwaitingCompactPrompt = true
      try {
        const r = await $.command.run({ command: 'compact', ...(pendingInstructions ? { args: pendingInstructions } : {}) })
        // 명령이 끝났는데 압축 훅을 지나지 않았다.
        if (isAwaitingCompactPrompt) notifyFailure($, msg.commandNoCompact(r.text))
      } catch (runErr) {
        notifyFailure($, msg.commandFailed(String(runErr)))
      }
      finish($)
      return
    }
    notifyFailure($, msg.compactFailed(String(err)))
  }
  finish($)
}

function finish($: EngineInterface) {
  isBusy = false
  isAwaitingHandoffTurn = false
  isAwaitingCompactPrompt = false
  compactLabel = undefined
  pendingInstructions = undefined
  redraw($)
}

// 데스크톱 앱은 플러그인 토스트를 그리지 않으므로 답 끝에도 남긴다.
function notifyFailure($: EngineInterface, text: string) {
  $.ui.toast(`state-compact: ${text}`)
  void $.clock.now().then(at => addMark($, { kind: 'failed', at, detail: text }))
}

// 지금 마지막 답에 기록을 붙인다. 답은 알지만 블록을 아직 못 찾았으면 찾을 때 붙이고,
// 답도 모르면(재시작 직후 턴 전) 남기지 않는다.
async function addMark($: EngineInterface, mark: Mark) {
  if (lastId === undefined) {
    if (lastAnswer !== undefined) pendingMarks.push(mark)
    return
  }
  marks.set(lastId, [...(marks.get(lastId) ?? []), mark])
  while (marks.size > MAX_MARKED_REPLIES) marks.delete(marks.keys().next().value!)
  redraw($)
  await $.store.set('marks', Object.fromEntries(marks))
}

function redraw($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

function markRow(mark: Mark): [string, string] {
  if (mark.kind === 'compacted') return [msg.compacted(mark.detail), hhmm(mark.at)]
  if (mark.kind === 'expired') return [msg.expired(mark.tokens), hhmm(mark.at)]
  return [msg.failed(mark.detail), hhmm(mark.at)]
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function tail(text: string): string {
  return text.trim().slice(-MATCH_TAIL_CHARS)
}

// 설정한 handoff 문서가 저장소 루트에 있으면 돌려준다. 설정이 비었거나 파일이 없으면 undefined.
async function findHandoffDoc($: EngineInterface): Promise<HandoffDoc | undefined> {
  if (!handoffFile) return undefined
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  if (top.exitCode !== 0) return undefined
  const root = top.stdout.trim()
  const path = `${root}/${handoffFile}`
  if (!(await $.fs.exists(path))) return undefined
  const tracked = await $.process.run(['git', 'ls-files', '--error-unmatch', handoffFile], { cwd: root })
  return { path, isTracked: tracked.exitCode === 0 }
}

async function isAwaitingReply($: EngineInterface, answer: string): Promise<boolean> {
  if (!answer.trim()) return false
  const r = await $.model.complete({
    model: 'haiku',
    system: CLASSIFY_SYSTEM,
    prompt: answer.slice(-CLASSIFY_TAIL_CHARS),
    maxTokens: 5,
    timeoutMs: 30_000,
  })
  // 판정하지 못하면 압축하지 않는다. 요약 손실을 감수할 근거가 없다.
  return r.isAnswered && r.text.trim().toUpperCase().startsWith('WAIT')
}

// 세션 기록 파일에서 마지막으로 캐시를 쓴 메인 응답의 TTL을 읽는다. 응답 usage에는 TTL별 값이
// 실려 오지 않아 기록 파일이 유일한 실측이다. 읽지 못하면 undefined.
async function readTtl($: EngineInterface): Promise<Ttl | undefined> {
  if (!transcriptPath) return undefined
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const r = isWindows
    ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', TAIL_POWERSHELL], {
        env: { STATE_COMPACT_TRANSCRIPT: transcriptPath },
      })
    : await $.process.run(['tail', '-c', String(TRANSCRIPT_TAIL_BYTES), transcriptPath])
  if (r.exitCode !== 0) return undefined
  const lines = r.stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"cache_creation"')) continue
    let entry: { type?: string; isSidechain?: boolean; message?: { usage?: { cache_creation?: Record<string, number> } } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const cc = entry.message?.usage?.cache_creation
    if (entry.type !== 'assistant' || entry.isSidechain || !cc) continue
    if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
    if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
  }
  return undefined
}
