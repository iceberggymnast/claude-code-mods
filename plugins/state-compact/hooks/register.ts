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

// 이 프로세스에서 마지막으로 보낸 메인 요청의 시작 시각. resume·재시작 직후에는 없으므로
// 그때는 만료 전 압축도, 수동 압축 앞의 반영 턴도 하지 않는다.
let lastRequestAt: number | undefined
let transcriptPath: string | undefined
let idleTimer: { cancel: () => void } | undefined
let idleAt: number | undefined
let idleLateAt: number | undefined
// handoff 문서 반영 → 압축 순서가 진행 중이다.
let isBusy = false
let isAwaitingHandoffTurn = false
let handoffTurnId: string | undefined
let pendingInstructions: string | undefined
// SDK 세션에서 압축을 /compact 프롬프트로 넣고 그 압축이 지나가기를 기다리는 중이다.
let isAwaitingCompactPrompt = false
// 마지막 실패 이유. 다음 턴이 시작될 때까지 상태 줄에 남긴다.
let failure: string | undefined
// 사용자 설정(userConfig). handoffFile이 비어 있으면 문서 반영 없이 압축만 한다.
let handoffFile = ''
let skipPattern: RegExp | undefined

export const register: Register = (on, options) => {
  handoffFile = String(options.handoff_file ?? '').trim()
  skipPattern = compilePattern(String(options.handoff_skip_pattern ?? ''))

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
    failure = undefined
    if (isAwaitingHandoffTurn) {
      isAwaitingHandoffTurn = false
      handoffTurnId = e.turnId
    }
    showStatus($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result

    // 넣은 /compact가 압축 없이 턴으로 끝났다. 슬래시 명령으로 처리되지 않은 것이다.
    if (isAwaitingCompactPrompt) {
      finish($)
      notifyFailure($, '/compact 프롬프트가 압축으로 처리되지 않았다')
      return result
    }

    if (handoffTurnId !== undefined && e.turnId === handoffTurnId) {
      handoffTurnId = undefined
      if (e.reason === 'answer') {
        $.clock.after(AFTER_TURN_MS, () => void compactNow($))
      } else {
        finish($)
        notifyFailure($, `${handoffFile} 반영이 끝나지 않아 압축하지 않았다`)
      }
      return result
    }

    if (isBusy || e.reason !== 'answer') return result

    const { context } = await $.session.usage()
    if ((context.percent ?? 0) >= PREEMPT_PERCENT) {
      $.clock.after(AFTER_TURN_MS, () => void begin($, `컨텍스트가 ${context.percent}%까지 찼다.`))
      return result
    }
    // 기록 파일 읽기와 응답 대기 판정에 몇 초가 걸린다. 턴 종료를 붙잡지 않도록 기다리지 않는다.
    void scheduleIdle($, context.tokens ?? 0, e.answer)
    return result
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
    $.clock.after(AFTER_TURN_MS, () => void begin($, '/compact를 실행했다.', e.instructions))
    return { skip: `state-compact: ${handoffFile}을 먼저 반영한 뒤 압축합니다` }
  })
}

// 사용자의 답을 기다리는 턴에서만 예약한다. 끝난 보고면 돌아올 가능성이 낮아 압축 비용만 남는다.
async function scheduleIdle($: EngineInterface, tokens: number, answer: string) {
  cancelIdle()
  showStatus($)
  const requestAt = lastRequestAt
  // 기준 토큰을 넘을 수 있을 때만 기록 파일을 읽는다. 작은 세션은 매 턴 프로세스를 띄울 이유가 없다.
  const minTokens = Math.min(IDLE_RULES['1h'].minTokens, IDLE_RULES['5m'].minTokens)
  if (requestAt === undefined || tokens < minTokens) return
  // 마지막 응답이 실제로 캐시된 TTL. 확인하지 못하면 예약하지 않는다.
  const ttl = await readTtl($)
  const rule = ttl && IDLE_RULES[ttl]
  if (!rule || tokens < rule.minTokens) return
  if (!(await isAwaitingReply($, answer))) return
  // 판정하는 몇 초 사이에 새 턴이 시작됐거나 압축이 진행 중이면 이 예약은 낡았다.
  if (lastRequestAt !== requestAt || isBusy) return
  const wait = rule.compactAfterMs - ((await $.clock.now()) - requestAt)
  if (wait <= 0) return
  idleAt = requestAt + rule.compactAfterMs
  idleLateAt = requestAt + rule.lateLimitMs
  idleTimer = $.clock.after(wait, () => void onIdle($))
  showStatus($)
}

async function onIdle($: EngineInterface) {
  const lateAt = idleLateAt
  idleTimer = undefined
  idleAt = undefined
  idleLateAt = undefined
  showStatus($)
  if (isBusy || lateAt === undefined) return
  if ((await $.clock.now()) > lateAt) return
  // 입력창에 쓰던 글이 있으면 자리에 있는 것이다.
  if ((await $.prompt.read()).text.trim() !== '') return
  await begin($, '자리를 비운 사이 프롬프트 캐시가 곧 만료된다.')
}

function cancelIdle() {
  idleTimer?.cancel()
  idleTimer = undefined
  idleAt = undefined
  idleLateAt = undefined
}

async function begin($: EngineInterface, reason: string, instructions?: string) {
  if (isBusy) return
  isBusy = true
  cancelIdle()
  showStatus($)
  pendingInstructions = instructions
  const doc = await findHandoffDoc($)
  if (!doc) {
    await compactNow($)
    return
  }
  isAwaitingHandoffTurn = true
  await $.prompt.submit({ text: handoffPrompt(doc, reason) })
}

async function compactNow($: EngineInterface) {
  try {
    const r = await $.session.compact(pendingInstructions ? { instructions: pendingInstructions } : undefined)
    if (r.skip) notifyFailure($, `압축이 취소됐다 (${r.skip})`)
  } catch (err) {
    // SDK 세션(데스크톱 앱 등)은 플러그인의 압축 호출을 거절하고, /compact 프롬프트의 턴 안에서만 압축한다.
    if (String(err).includes('headless')) {
      isAwaitingCompactPrompt = true
      const text = pendingInstructions ? `/compact ${pendingInstructions}` : '/compact'
      await $.prompt.submit({ text, asUser: true })
      return
    }
    notifyFailure($, `압축하지 못했다 (${String(err)})`)
  }
  finish($)
}

function finish($: EngineInterface) {
  isBusy = false
  isAwaitingHandoffTurn = false
  isAwaitingCompactPrompt = false
  pendingInstructions = undefined
  showStatus($)
}

// 데스크톱 앱은 플러그인 토스트를 그리지 않으므로 상태 줄에도 남긴다.
function notifyFailure($: EngineInterface, text: string) {
  failure = text
  $.ui.toast(`state-compact: ${text}`)
  showStatus($)
}

// 프롬프트 아래 한 줄: 켜져 있음(반영할 문서) / 압축 예약 시각 / 진행 중 / 실패 이유.
function showStatus($: EngineInterface) {
  const name = handoffFile ? `state-compact · ${handoffFile}` : 'state-compact'
  if (isBusy) {
    $.ui.status(`◆ ${name}: 압축 중`)
  } else if (failure !== undefined) {
    $.ui.status(`◇ ${name}: ${failure}`)
  } else if (idleAt !== undefined) {
    const at = new Date(idleAt)
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    $.ui.status(`◇ ${name}: ${hhmm} 압축 예정`)
  } else {
    $.ui.status(`◇ ${name}`)
  }
}

function handoffPrompt(doc: HandoffDoc, reason: string): string {
  const commit = doc.isTracked
    ? `${handoffFile}은 git이 추적하는 파일이다. \`git commit -- ${handoffFile}\` 형식으로 이 파일만 커밋하라. 다른 변경은 커밋에 넣지 마라.`
    : `${handoffFile}은 git이 추적하지 않는 파일이다. 커밋하지 마라.`
  return [
    `[state-compact] ${reason} 곧 대화를 압축한다. 압축하면 지금 대화의 세부 내용은 요약으로 바뀐다.`,
    `압축 전에 ${doc.path}에 지금까지 진행한 내용과 다음에 할 일을 반영하라.`,
    commit,
    '그 밖의 작업은 하지 말고, 끝나면 무엇을 고쳤는지 한 줄로만 답하라.',
  ].join('\n')
}

// 설정한 handoff 문서가 저장소 루트에 있으면 돌려준다. 설정이 비었거나, 파일이 없거나,
// 내용이 건너뛰기 패턴에 맞으면(진행 중인 작업 없음) undefined.
async function findHandoffDoc($: EngineInterface): Promise<HandoffDoc | undefined> {
  if (!handoffFile) return undefined
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  if (top.exitCode !== 0) return undefined
  const root = top.stdout.trim()
  const path = `${root}/${handoffFile}`
  if (!(await $.fs.exists(path))) return undefined
  if (skipPattern?.test(await $.fs.read(path))) return undefined
  const tracked = await $.process.run(['git', 'ls-files', '--error-unmatch', handoffFile], { cwd: root })
  return { path, isTracked: tracked.exitCode === 0 }
}

// 정규식이 잘못됐으면 건너뛰기 없이 동작한다. 줄 단위로 맞추도록 m 플래그를 붙인다.
function compilePattern(source: string): RegExp | undefined {
  if (!source.trim()) return undefined
  try {
    return new RegExp(source, 'm')
  } catch {
    return undefined
  }
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
