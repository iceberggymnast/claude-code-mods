import type { EngineInterface, Register, Timer } from 'claude-code'

import { bar, hudSvg, PHASE_LABEL, seconds } from './hud'
import type { Phase } from './hud'

// 속도를 다시 재는 주기(데스크톱이 다시 그리는 한도인 초당 10회)와, 속도를 재는 구간
const TICK_MS = 100
const WINDOW_MS = 1000
// 표시값이 매 주기 측정값 쪽으로 다가가는 비율. 숫자가 한 번에 뛰지 않고 차례로 올라가고 내려간다.
const DISPLAY_EASE = 0.3
// 턴이 끝나 0으로 내려가던 표시값이 이보다 작아지면 0으로 두고 타이머를 멈춘다
const PARKED_TPS = 0.5
// 그림을 다시 그리는 기준 해상도. 표시값이 이만큼도 안 바뀌었으면 다시 그리지 않는다.
const REDRAW_TPS_STEP = 0.1

// 속도는 Artificial Analysis 기준으로 잰다: 화면에 나온 답(본문과 도구 입력)을 OpenAI o200k_base 토큰으로 세고,
// 답이 나오는 동안의 시간으로 나눈다. 생각 구간은 넣지 않는다.
// o200k 토큰은 문자 종류별 글자당 비용으로 추정한다. Claude Code 세션 기록의 답 6,000개로 tiktoken과 맞춘 값이고,
// 따로 둔 6,000개에서 전체 오차 -0.6%, 한글 비중별로 나눠도 ±4% 안이다.
const O200K_PER_HANGUL = 0.8987
const O200K_PER_ALNUM = 0.2533
const O200K_PER_SPACE = 0.1001
const O200K_PER_PUNCT = 0.6116
const O200K_PER_OTHER = 1

// 글자는 UTF-16 단위로 센다. 비용은 코드 포인트 단위로 맞췄으므로 이모지(2단위)는 두 배로 잡히고,
// U+3000 같은 유니코드 공백은 기타로 센다. Claude Code의 답에는 드물어 오차에 거의 들어가지 않는다.
function o200kTokens(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) n += O200K_PER_HANGUL
    else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n += O200K_PER_ALNUM
    else if (c === 32 || (c >= 9 && c <= 13)) n += O200K_PER_SPACE
    else if (c >= 33 && c <= 126) n += O200K_PER_PUNCT
    else n += O200K_PER_OTHER
  }
  return n
}

type Sample = { at: number; tokens: number }

// 이번 턴의 측정값. 조각이 올 때는 토큰 추정치만 더하고, 속도는 타이머가 계산한다.
// 턴이 끝나도 다음 턴이 시작될 때까지 남겨 P 표시에 쓴다.
let hasTurn = false
let isParked = false
let timer: Timer | undefined
let turnStartAt = 0
let phase: Phase = 'request'
let gear = '1'
let tokens = 0
let launchTaken = false
let launchMs: number | undefined
let answerTokens = 0
let answerMs = 0
let samples: Sample[] = []
let liveTps = 0
let maxTps = 0
let closing: Promise<void> = Promise.resolve()

// 마지막으로 그린 그림의 속도와 표시 내용
let shownTps = 0
let frameKey = ''

// 끝난 응답들의 평균: 답의 토큰 / 첫 글자부터 끝까지의 시간
function averageTps(): number | undefined {
  return answerMs > 0 ? answerTokens / (answerMs / 1000) : undefined
}

// 표시 내용이 바뀌었을 때만 다시 그린다. 데스크톱은 초당 10번까지 다시 그린다.
function redraw($: EngineInterface): void {
  const avg = averageTps()
  const key = [
    isParked,
    phase,
    gear,
    Math.round(liveTps / REDRAW_TPS_STEP),
    Math.round(maxTps),
    avg === undefined ? '' : Math.round(avg),
    launchMs ?? '',
  ].join('|')
  if (key === frameKey) return
  frameKey = key
  shownTps = liveTps
  $.ui.invalidate('ui.render')
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  samples.push({ at: now, tokens })
  // 구간 시작 직전의 표본 하나를 남긴다. 타이머가 몰려서 울려도 속도를 재는 구간이 WINDOW_MS보다 짧아지지 않는다.
  while ((samples[1]?.at ?? now) <= now - WINDOW_MS) samples.shift()
  const oldest = samples[0] ?? { at: now, tokens }
  // 답이 나오는 중이 아니면 바로 0을 향한다. 구간 안에 남은 지난 출력 때문에 생각·도구 실행 중에 숫자가 오르지 않게 한다.
  const isOutput = phase === 'output' && !isParked
  const measured = !isOutput || now <= oldest.at ? 0 : (tokens - oldest.tokens) / ((now - oldest.at) / 1000)
  liveTps += (measured - liveTps) * DISPLAY_EASE
  maxTps = Math.max(maxTps, liveTps)
  if (isParked && liveTps < PARKED_TPS) {
    liveTps = 0
    timer?.cancel()
    timer = undefined
  }
  redraw($)
}

async function closeStep($: EngineInterface, answerAt: Promise<number>, stepTokens: number): Promise<void> {
  const [start, end] = await Promise.all([answerAt, $.clock.now()])
  if (end <= start) return
  answerTokens += stepTokens
  answerMs += end - start
}

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    timer?.cancel()
    turnStartAt = await $.clock.now()
    hasTurn = true
    isParked = false
    phase = 'request'
    gear = '1'
    tokens = 0
    launchTaken = false
    launchMs = undefined
    answerTokens = 0
    answerMs = 0
    samples = [{ at: turnStartAt, tokens: 0 }]
    liveTps = 0
    maxTps = 0
    shownTps = 0
    timer = $.clock.every(TICK_MS, () => void tick($))
    redraw($)
    return next(e)
  })

  // 메인 대화의 응답만 잰다. 서브에이전트의 응답이 섞이면 속도가 부풀어 오른다.
  // 조각을 넘기는 길에서는 기다리지 않는다. 시각은 $.clock.now()를 걸어 두기만 하고 끝날 때 모아 읽는다.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !hasTurn || isParked) return yield* next(e)

    phase = 'request'
    gear = String(e.index + 1)
    let answerAt: Promise<number> | undefined
    let stepTokens = 0
    try {
      for await (const c of next(e)) {
        if (!launchTaken) {
          launchTaken = true
          void $.clock.now().then(t => {
            launchMs = t - turnStartAt
          })
        }
        if (phase === 'request') phase = 'thinking'
        const text = c.kind === 'text' ? c.text : c.kind === 'input' ? c.json : ''
        if (text.length > 0) {
          if (answerAt === undefined) {
            answerAt = $.clock.now()
            phase = 'output'
          }
          const n = o200kTokens(text)
          tokens += n
          stepTokens += n
        }
        yield c
      }
    } finally {
      phase = 'tool'
      if (answerAt !== undefined) closing = closeStep($, answerAt, stepTokens)
    }
  })

  // 턴이 끝나면 P로 두고, 표시값은 타이머가 0까지 내린 뒤 멈춘다.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || !hasTurn || isParked) return next(e)

    await closing
    isParked = true
    redraw($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !hasTurn) return next(e)

    const avg = averageTps()
    const title = isParked ? '턴 종료' : PHASE_LABEL[phase]
    const summary =
      `${title} ${Math.round(shownTps)} tok/s · 평균 ${avg === undefined ? '—' : Math.round(avg)}` +
      ` · 최고 ${Math.round(maxTps)} · 출발 ${seconds(launchMs)}`
    const elements = $.ui.resolve(e)

    // 터미널은 고정폭 글자로 막대를 그린다. 'Svg' in 검사는 타입을 좁히는 용도이고, 실행 중 표에는 터미널에도 그 키가 있다.
    if (e.surface === 'terminal' || !('Svg' in elements)) {
      const { Box, Text } = elements
      return (
        <Box borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor={isParked}>{`${bar(shownTps)}  ${summary}`}</Text>
        </Box>
      )
    }

    const { Box, Svg } = elements
    const shownGear = isParked ? 'P' : phase === 'thinking' || phase === 'tool' ? 'N' : gear
    const view = {
      tps: shownTps,
      avgTps: avg,
      maxTps,
      launchMs,
      phase: isParked ? undefined : phase,
      gear: shownGear,
    }
    // 그림 모드로 그린다. 대화형(isInteractive)은 그림 안의 애니메이션이 돌지만 데스크톱에서 크기가 줄고 갱신마다 깜박였다.
    // 그림 모드에서는 애니메이션이 돌지 않는다(녹화로 확인: 막대가 6프레임마다 바뀜).
    return (
      <Box>
        <Svg source={hudSvg(view)} alt={`토큰 속도계: ${summary}`} />
      </Box>
    )
  })
}
