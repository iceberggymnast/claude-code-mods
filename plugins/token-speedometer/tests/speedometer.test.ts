import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'token-speedometer',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'test' }

// 엔진 자리: 턴 시작·끝은 받은 대로 돌려주고, 띠에는 아무것도 그리지 않는다
function engine(on: On) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Box' }))
}

const speedOf = (s: string | undefined) => Number(/(\d+) tok\/s/.exec(s ?? '')?.[1])

test('답이 나오는 동안만 o200k 토큰 추정치로 재고, 한국어와 영어를 다르게 센다', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)

  // 엔진 자리: hiddenMs 동안 보이지 않는 thinking, 이어서 3초 동안 0.1초마다 say 한 조각, 끝나면 stop.
  // 조각은 타이머 주기 사이(…50ms)에 와서 측정 구간에 걸리는 조각 수가 늘 같다.
  let hiddenMs = 0
  let say = ''
  on('turn.step', async function* ($, e) {
    if (hiddenMs > 0) {
      yield { kind: 'thinking', index: 0, text: '' }
      await clock.sleep(hiddenMs)
    }
    for (let i = 0; i < 30; i++) {
      await clock.sleep(50)
      yield { kind: 'text', index: 1, text: say }
      await clock.sleep(50)
    }
    const usage = { ...USAGE, output_tokens: 999 }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })

  const band = async (surface: 'desktop' | 'terminal') => {
    const ui = await $.ui.mount({ ...BAND, surface })
    const dial = await ui.find({ type: 'Svg' })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    return { alt: dial?.props.alt as string | undefined, source: dial?.props.source as string | undefined, texts }
  }

  const begin = async (turnId: string) => {
    await $.turn.start({ text: 'hi', turnId })
    const stream = $.turn.step({ turnId, index: 0, model: 'test', messageCount: 1 })
    // 객체로 감싸 돌려준다. promise를 그대로 돌려주면 begin을 기다리는 쪽이 응답이 끝날 때까지 멈춘다.
    const drained = (async () => {
      for await (const _ of stream) {
        // 다 읽어야 응답이 끝난다
      }
    })()
    return { drained }
  }
  const end = (turnId: string) => $.turn.complete({ answer: 'ok', durationMs: 0, isAborted: false, turnId, reason: 'answer' })

  expect((await band('desktop')).alt).toBeUndefined()

  // 첫 턴: 1초 thinking 뒤 영문 30글자 조각(o200k 약 7.6토큰) 30개. API가 보고한 output_tokens(999)는 쓰지 않는다.
  hiddenMs = 1000
  say = 'x'.repeat(30)
  const first = await begin('t1')
  await clock.advance(500)
  const thinking = await band('desktop')
  expect(thinking.alt).toContain('생각 중 0 tok/s')
  expect(thinking.source).toContain('>N</text>')
  await clock.advance(3500)
  await first.drained
  await end('t1')
  // 턴이 끝나면 P로 두고 숫자는 0까지 내려간다. 평균은 답이 나온 시간만으로: 30 × 7.6토큰 / 2.95초(1.05초~4초) ≈ 77
  await clock.advance(3000)
  const after = await band('desktop')
  expect(after.alt).toContain('턴 종료 0 tok/s')
  expect(after.alt).toContain('평균 77')
  expect(after.alt).toContain('출발 0.0s')
  expect(after.source).toContain('>P</text>')

  // 둘째 턴: 한글 10글자 조각(o200k 약 9.0토큰)을 초당 10개 → 약 90 tok/s. 영문은 글자가 3배여도 더 느리게 나온다.
  hiddenMs = 0
  say = '가'.repeat(10)
  const second = await begin('t2')
  await clock.advance(2900)
  const live = await band('desktop')
  expect(live.alt).toContain('출력 중')
  expect(live.source).toContain('>1</text>')
  expect(Math.abs(speedOf(live.alt) - 90)).toBeLessThanOrEqual(2)
  expect(Math.abs(speedOf((await band('terminal')).texts[0]) - 90)).toBeLessThanOrEqual(2)
  await clock.advance(100)
  await second.drained
  // 출력이 끝나 도구 실행으로 넘어가면 바로 감속한다(지난 1초 구간에 남은 출력으로 숫자가 오르지 않는다)
  await clock.advance(300)
  const afterOutput = await band('desktop')
  expect(afterOutput.alt).toContain('도구 실행')
  expect(speedOf(afterOutput.alt)).toBeLessThan(50)
  await end('t2')
})

test('서브에이전트의 응답은 세지 않는다', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'x'.repeat(300) }
    const usage = { ...USAGE, output_tokens: 100 }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })

  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'test', messageCount: 1, agentId: 'a1' })) {
    // 다 읽는다
  }
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('응답 대기 0 tok/s')
  await ui.unmount()
})
