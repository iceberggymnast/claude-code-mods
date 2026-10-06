// 속도계 그림. 측정과 상관없는 순수 함수만 둔다.

// 응답 사이: 모델 요청을 보내고 첫 조각을 기다림 · 첫 조각은 왔지만 보이는 출력이 아직 없음 · 출력이 나오는 중 · 도구 실행
export type Phase = 'request' | 'thinking' | 'output' | 'tool'

export const PHASE_LABEL: Record<Phase, string> = {
  request: '응답 대기',
  thinking: '생각 중',
  output: '출력 중',
  tool: '도구 실행',
}
const PHASE_LAMP: Record<Phase, string> = { request: 'REQ', thinking: 'THK', output: 'OUT', tool: 'TOOL' }
const PHASES: readonly Phase[] = ['request', 'thinking', 'output', 'tool']

// 막대가 끝까지 차는 속도와 빨간 구간이 시작되는 비율
const GAUGE_MAX_TPS = 200
const REDLINE_FRACTION = 0.8

// 데스크톱 계기판. 배경 없이 그리고, 색은 앱의 밝은·어두운 모드에 따라 아래 두 벌 중 하나를 쓴다.
// 흰색·검은색 요소의 글로우(gw)는 밝은 배경에서 번져 보여서 어두운 모드에서만 켠다. 초록·빨강은 늘 빛난다.
const HUD_WIDTH = 720
const HUD_HEIGHT = 34
const BAR_SEGMENTS = 56
// 속도가 0이어도 켜 두는 칸 수(공회전)
const IDLE_SEGMENTS = 3
// 칸을 기울이는 정도(칸 높이 대비 가로 밀림)
const SEGMENT_SLANT = 0.36
const HUD_STYLE =
  '.d{fill:#151515}.dd{fill:#d0d0d0}.l{fill:#707070}.on{fill:#151515}.off{fill:#cfcfcf}' +
  '.g0{stop-color:#b5b5b5}.g1{stop-color:#1a1a1a}.so{fill:#e6e6e6}.r{fill:#e8323c}.ro{fill:#f19ca1}' +
  '.u{fill:#1a1a1a;stroke:#1a1a1a}.g{fill:#18a058}.gr{stroke:#18a058}.n{fill:#e8323c}.nr{stroke:#e8323c}' +
  '@media (prefers-color-scheme: dark){' +
  '.d{fill:#f5f5f5}.dd{fill:#3f4247}.l{fill:#9aa0a6}.on{fill:#f5f5f5}.off{fill:#3a3d42}' +
  '.g0{stop-color:#5f6368}.g1{stop-color:#ffffff}.so{fill:#2a2d31}.r{fill:#ff3b3b}.ro{fill:#a3222b}' +
  '.u{fill:#ffffff;stroke:#ffffff}.g{fill:#3ddc84}.gr{stroke:#3ddc84}.n{fill:#ff4d4d}.nr{stroke:#ff4d4d}' +
  '.gw{filter:url(#glow)}}'

// 터미널 막대
const BAR_CELLS = 10
const BAR_GLYPHS = '▁▂▃▄▅▆▇█'
const EMPTY_GLYPH = '░'

export type HudView = {
  tps: number
  // 끝난 응답들의 정확한 평균. 아직 끝난 응답이 없으면 없다.
  avgTps: number | undefined
  maxTps: number
  launchMs: number | undefined
  // 응답이 진행 중일 때의 상태. 턴이 끝나면(P) 없다.
  phase: Phase | undefined
  // 몇 번째 모델 요청인지. 생각 중·도구 실행이면 N, 턴이 끝나면 P(둘 다 빨간색)
  gear: string
}

function fraction(tps: number): number {
  return Math.min(Math.max(tps / GAUGE_MAX_TPS, 0), 1)
}

export function seconds(ms: number | undefined): string {
  return ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`
}

export function hudSvg(v: HudView): string {
  const digits = String(Math.min(Math.round(v.tps), 999)).padStart(3, '0')
  const lead = digits.length - digits.replace(/^0+(?=\d)/, '').length
  const isNeutral = v.gear === 'P' || v.gear === 'N'

  const barLeft = 232
  const barRight = 562
  const barTop = 8
  const barHeight = 16
  const gap = 2.2
  const slant = barHeight * SEGMENT_SLANT
  const pitch = (barRight - slant - barLeft + gap) / BAR_SEGMENTS
  const segmentWidth = pitch - gap
  const redFrom = Math.ceil(BAR_SEGMENTS * REDLINE_FRACTION)
  // 켜진 칸 수(공회전 칸 수보다 적어지지 않는다)와 그 끝(마지막 켜진 칸의 아랫변 오른쪽 x)
  const lit = Math.max(Math.round(fraction(v.tps) * BAR_SEGMENTS), IDLE_SEGMENTS)
  const edge = barLeft + lit * pitch - gap
  const segment = (i: number) => {
    const x = barLeft + i * pitch
    const b = barTop + barHeight
    return `M${(x + slant).toFixed(1)} ${barTop}H${(x + slant + segmentWidth).toFixed(1)}L${(x + segmentWidth).toFixed(1)} ${b}H${x.toFixed(1)}Z`
  }

  let litNormal = ''
  let litRed = ''
  let offNormal = ''
  let offRed = ''
  for (let i = 0; i < BAR_SEGMENTS; i++) {
    const d = segment(i)
    if (i < lit) {
      if (i >= redFrom) litRed += d
      else litNormal += d
    } else if (i >= redFrom) offRed += d
    else offNormal += d
  }

  let s =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${HUD_WIDTH}" height="${HUD_HEIGHT}" viewBox="0 0 ${HUD_WIDTH} ${HUD_HEIGHT}"` +
    ` font-family="'Segoe UI', 'Helvetica Neue', system-ui, sans-serif"><style>${HUD_STYLE}</style>` +
    `<defs>` +
    `<filter id="glow" x="-50%" y="-80%" width="200%" height="260%">` +
    `<feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="${barLeft}" y1="0" x2="${edge.toFixed(1)}" y2="0">` +
    `<stop offset="0" class="g0"/><stop offset="1" class="g1"/></linearGradient>` +
    `</defs>`

  // 기어
  s +=
    `<g filter="url(#glow)">` +
    `<circle cx="17" cy="17" r="12" fill="none" stroke-width="2" class="${isNeutral ? 'nr' : 'gr'}"/>` +
    `<text x="17" y="21.5" text-anchor="middle" font-size="${v.gear.length > 1 ? 10 : 13}" font-weight="700" class="${isNeutral ? 'n' : 'g'}">${v.gear}</text>` +
    `</g>`

  // 큰 숫자. 칸마다 따로 그려 자릿수가 바뀌어도 위치가 흔들리지 않는다. 앞자리 0은 어둡게, 나머지는 빛나게.
  let dim = ''
  let bright = ''
  for (let i = 0; i < digits.length; i++) {
    const t = `<text x="${50 + i * 22}" y="30" text-anchor="middle">${digits[i]}</text>`
    if (i < lead) dim += t
    else bright += t
  }
  s +=
    `<g font-size="36" font-weight="300" font-style="italic">` +
    `<g class="dd">${dim}</g><g class="d gw">${bright}</g></g>`

  // 단위와 상태 표시등
  s += `<text x="116" y="12" font-size="9" letter-spacing="1" class="l">TOK/S</text>`
  PHASES.forEach((p, i) => {
    const isOn = p === v.phase
    s += `<text x="${116 + i * 26}" y="27" font-size="8" font-weight="600" letter-spacing="0.5" class="${isOn ? 'on gw' : 'off'}">${PHASE_LAMP[p]}</text>`
  })

  // 기울인 분할 막대: 꺼진 칸, 켜진 칸(그라데이션과 글로우), 아래 진행선과 끝점
  s +=
    `<path d="${offNormal}" class="so"/>` +
    `<path d="${offRed}" class="ro"/>` +
    `<path d="${litNormal}" fill="url(#fill)" class="gw"/>` +
    `<path d="${litRed}" class="r" filter="url(#glow)"/>` +
    `<rect x="${barLeft}" y="28" width="${(edge - barLeft).toFixed(1)}" height="1.2" fill="url(#fill)"/>` +
    `<circle cx="${edge.toFixed(1)}" cy="28.6" r="1.8" class="u gw"/>`

  // 이번 턴의 최고 속도
  if (v.maxTps > 0) {
    const x = barLeft + slant + fraction(v.maxTps) * (barRight - slant - barLeft)
    s += `<path d="M${(x - 3.5).toFixed(1)} 1L${(x + 3.5).toFixed(1)} 1L${x.toFixed(1)} 5.5Z" class="d"/>`
  }

  // 평균 · 최고 · 출발
  const stats: [string, string][] = [
    ['AVG', v.avgTps === undefined ? '—' : String(Math.round(v.avgTps))],
    ['TOP', String(Math.round(v.maxTps))],
    ['LAUNCH', seconds(v.launchMs)],
  ]
  stats.forEach(([label, value], i) => {
    const x = 584 + i * 46
    s +=
      `<text x="${x}" y="11" font-size="8" letter-spacing="0.8" class="l">${label}</text>` +
      `<text x="${x}" y="28" font-size="14" font-style="italic" class="d">${value}</text>`
  })

  return s + '</svg>'
}

export function bar(tps: number): string {
  const filled = Math.round(fraction(tps) * BAR_CELLS)
  let out = ''
  for (let i = 0; i < BAR_CELLS; i++) {
    out += i < filled ? BAR_GLYPHS[Math.floor((i * BAR_GLYPHS.length) / BAR_CELLS)] : EMPTY_GLYPH
  }
  return out
}
