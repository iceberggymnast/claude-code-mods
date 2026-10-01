import type { EngineInterface, Register } from 'claude-code'

// 만료 전 압축은 컨텍스트가 이보다 작으면 하지 않는다. 입력 단가 단위로 돌아왔을 때 아끼는 양이
// 대략 1.8 × 컨텍스트 - 19만이라, 20만 아래는 아끼는 양이 작고 요약 손실만 남는다.
const IDLE_MIN_TOKENS = 200_000
// 마지막 요청 시작 후 이만큼 지나면 압축을 시작한다. 1시간 TTL에 5분 여유를 둔다.
const IDLE_COMPACT_MS = 55 * 60_000
// 타이머가 이보다 늦게 돌면(절전에서 깨어남) 캐시가 이미 만료된 것으로 보고 건너뛴다.
const LATE_LIMIT_MS = 58 * 60_000
// 컨텍스트가 창의 이 비율을 넘기면 자동 압축이 오기 전에 STATE.md 반영 후 먼저 압축한다.
const PREEMPT_PERCENT = 85
const ONE_HOUR_MS = 60 * 60_000
const FIVE_MIN_MS = 5 * 60_000
// 수동 /compact 때 캐시가 살아 있다고 보는 여유. 이보다 만료에 가까우면 STATE 턴을 넣지 않는다.
const CACHE_MARGIN_MS = 2 * 60_000
// 응답 대기 판정에 넘기는 마지막 답변의 길이.
const CLASSIFY_TAIL_CHARS = 4000
// 압축 직전 턴이 끝난 뒤 압축을 부르기까지의 간격. 턴이 도는 동안 compact는 거절된다.
const AFTER_TURN_MS = 1000
// TTL을 찾으려고 세션 기록 파일 끝에서 읽는 바이트 수.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024

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
type StateDoc = { path: string; isTracked: boolean }

// 이 프로세스에서 마지막으로 보낸 메인 요청의 시작 시각. resume·재시작 직후에는 없으므로
// 그때는 만료 전 압축도, 수동 압축 앞의 STATE 턴도 하지 않는다.
let lastRequestAt: number | undefined
let transcriptPath: string | undefined
let lastAnswer = ''
let idleTimer: { cancel: () => void } | undefined
let idleAt: number | undefined
// STATE 반영 → 압축 순서가 진행 중이다.
let isBusy = false
let isAwaitingStateTurn = false
let stateTurnId: string | undefined
let pendingInstructions: string | undefined

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    showStatus($)
    return next(e)
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
    cancelIdle()
    if (isAwaitingStateTurn) {
      isAwaitingStateTurn = false
      stateTurnId = e.turnId
    }
    showStatus($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result

    if (stateTurnId !== undefined && e.turnId === stateTurnId) {
      stateTurnId = undefined
      if (e.reason === 'answer') {
        $.clock.after(AFTER_TURN_MS, () => void compactNow($))
      } else {
        finish($)
        $.ui.toast('state-compact: STATE.md 반영이 끝나지 않아 압축하지 않았다')
      }
      return result
    }

    if (isBusy || e.reason !== 'answer') return result
    lastAnswer = e.answer

    const { context } = await $.session.usage()
    if ((context.percent ?? 0) >= PREEMPT_PERCENT) {
      $.clock.after(AFTER_TURN_MS, () => void begin($, `컨텍스트가 ${context.percent}%까지 찼다.`))
      return result
    }
    await scheduleIdle($, context.tokens ?? 0)
    return result
  })

  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    if (e.agentId || isBusy) return next(e)
    // TTL을 확인하지 못하면 짧은 쪽으로 본다.
    const ttlMs = (await readTtl($)) === '1h' ? ONE_HOUR_MS : FIVE_MIN_MS
    // resume한 세션이나 오래 쉰 세션은 캐시가 이미 없다. STATE 턴을 넣으면 전체를 한 번 더
    // 캐시하게 되므로 그대로 압축한다.
    if (lastRequestAt === undefined || (await $.clock.now()) - lastRequestAt > ttlMs - CACHE_MARGIN_MS) {
      return next(e)
    }
    if (!(await findStateDoc($))) return next(e)
    $.clock.after(AFTER_TURN_MS, () => void begin($, '/compact를 실행했다.', e.instructions))
    return { skip: 'state-compact: STATE.md를 먼저 반영한 뒤 압축합니다' }
  })
}

async function scheduleIdle($: EngineInterface, tokens: number) {
  cancelIdle()
  if (lastRequestAt !== undefined && tokens >= IDLE_MIN_TOKENS) {
    const wait = IDLE_COMPACT_MS - ((await $.clock.now()) - lastRequestAt)
    if (wait > 0) {
      idleAt = lastRequestAt + IDLE_COMPACT_MS
      idleTimer = $.clock.after(wait, () => void onIdle($))
    }
  }
  showStatus($)
}

async function onIdle($: EngineInterface) {
  idleTimer = undefined
  idleAt = undefined
  showStatus($)
  if (isBusy || lastRequestAt === undefined) return
  if ((await $.clock.now()) - lastRequestAt > LATE_LIMIT_MS) return
  // 마지막 응답이 실제로 1시간 TTL로 캐시됐을 때만 압축한다. 5분이었으면 캐시는 이미 없다.
  if ((await readTtl($)) !== '1h') return
  // 입력창에 쓰던 글이 있으면 자리에 있는 것이다.
  if ((await $.prompt.read()).text.trim() !== '') return
  if (!(await isAwaitingReply($, lastAnswer))) return
  await begin($, '자리를 비운 사이 프롬프트 캐시가 곧 만료된다.')
}

function cancelIdle() {
  idleTimer?.cancel()
  idleTimer = undefined
  idleAt = undefined
}

async function begin($: EngineInterface, reason: string, instructions?: string) {
  if (isBusy) return
  isBusy = true
  cancelIdle()
  showStatus($)
  pendingInstructions = instructions
  const doc = await findStateDoc($)
  if (!doc) {
    await compactNow($)
    return
  }
  isAwaitingStateTurn = true
  await $.prompt.submit({ text: statePrompt(doc, reason) })
}

async function compactNow($: EngineInterface) {
  try {
    const r = await $.session.compact(pendingInstructions ? { instructions: pendingInstructions } : undefined)
    if (r.skip) $.ui.toast(`state-compact: 압축이 취소됐다 (${r.skip})`)
  } catch (err) {
    $.ui.toast(`state-compact: 압축하지 못했다 (${String(err)})`)
  } finally {
    finish($)
  }
}

function finish($: EngineInterface) {
  isBusy = false
  isAwaitingStateTurn = false
  pendingInstructions = undefined
  showStatus($)
}

// 프롬프트 아래 한 줄: 켜져 있음 / 압축 예약 시각 / 진행 중.
function showStatus($: EngineInterface) {
  if (isBusy) {
    $.ui.status('◆ state-compact: STATE 반영 후 압축 중')
  } else if (idleAt !== undefined) {
    const at = new Date(idleAt)
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    $.ui.status(`◇ state-compact: ${hhmm} 압축 예정`)
  } else {
    $.ui.status('◇ state-compact')
  }
}

function statePrompt(doc: StateDoc, reason: string): string {
  const commit = doc.isTracked
    ? 'STATE.md는 git이 추적하는 파일이다. `git commit -- STATE.md` 형식으로 STATE.md만 커밋하라. 다른 변경은 커밋에 넣지 마라.'
    : 'STATE.md는 git이 추적하지 않는 파일이다. 커밋하지 마라.'
  return [
    `[state-compact] ${reason} 곧 대화를 압축한다. 압축하면 지금 대화의 세부 내용은 요약으로 바뀐다.`,
    `압축 전에 ${doc.path}의 체크 항목과 다음 한 걸음을 지금까지 진행한 내용 기준으로 고쳐라.`,
    commit,
    '그 밖의 작업은 하지 말고, 끝나면 무엇을 고쳤는지 한 줄로만 답하라.',
  ].join('\n')
}

// 저장소 루트의 STATE.md. 목표 줄이 "(없음)"이거나 템플릿 그대로("(한 줄")면 진행 중인 작업이 없다고 본다.
async function findStateDoc($: EngineInterface): Promise<StateDoc | undefined> {
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  if (top.exitCode !== 0) return undefined
  const root = top.stdout.trim()
  const path = `${root}/STATE.md`
  if (!(await $.fs.exists(path))) return undefined
  const goal = (await $.fs.read(path)).split(/\r?\n/).find(line => /^\s*-\s*목표/.test(line))
  if (goal && /:\s*\((없음|한 줄)/.test(goal)) return undefined
  const tracked = await $.process.run(['git', 'ls-files', '--error-unmatch', 'STATE.md'], { cwd: root })
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
    const line = lines[i]
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
