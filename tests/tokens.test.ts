import { expect, mock, test } from 'claude-code/testing'

import { countOf, durationOf, linesOf, usdOf, widthOf } from '../hooks/view'
import type { Entry, Line } from '../hooks/view'

function textOf(line: Line): string {
  return line.map(segment => segment.text).join('')
}

const BASE = new Date(2026, 9, 3, 10, 42, 3).getTime()

/** 跟草圖一樣的三筆：兩筆收完、最後一筆還在等。 */
function sampleEntries(): Entry[] {
  return [
    { sentAt: BASE, doneAt: BASE + 8_200, status: 'done', sent: 85_320, cached: 82_760, received: 412, cost: 0.0614 },
    { sentAt: BASE + 9_000, doneAt: BASE + 27_000, status: 'done', sent: 85_904, cached: 85_045, received: 2_031, cost: null },
    { sentAt: BASE + 28_000, doneAt: null, status: 'waiting', sent: 0, cached: 0, received: 0, cost: null },
  ]
}

test('數字、時間的寫法', async () => {
  expect(countOf(1_284_530)).toBe('1,284,530')
  expect(countOf(412)).toBe('412')
  expect(countOf(-3)).toBe('0')
  expect(durationOf(8_249)).toBe('8.2 秒')
  expect(durationOf(3_900, true)).toBe('3 秒')
  expect(durationOf(65_000)).toBe('1 分 05 秒')
  expect(usdOf(0.0306, 3)).toBe('$0.031')
  expect(usdOf(1.274, 2)).toBe('$1.27')
  expect(usdOf(-0.2, 2)).toBe('$0.00')
})

test('每一行都不超過寬度，草圖上的字都在', async () => {
  const main = { sent: 1_284_530, received: 18_402 }
  const helper = { sent: 210_400, received: 3_120 }

  for (const columns of [30, 47, 73]) {
    for (const line of linesOf(sampleEntries(), 3, main, helper, BASE + 31_500, columns, 40)) {
      expect(widthOf(textOf(line))).toBeLessThanOrEqual(columns)
    }
  }

  const all = linesOf(sampleEntries(), 3, main, helper, BASE + 31_500, 47, 40).map(textOf).join('\n')

  expect(all).toContain('最近 3 筆，共 3 筆')
  expect(all).toMatch(/合計 +↑ 送出 1,284,530 +↓ 收到 18,402/)
  expect(all).toContain('（幫手另計 ↑ 210,400  ↓ 3,120）')
  expect(all).toMatch(/10:42:03 +↑ 送出 +85,320 +快取 97%/)
  expect(all).toContain('⋯ 等待回應 8.2 秒')
  expect(all).toMatch(/10:42:11 +↓ 收到 +412/)
  expect(all).toMatch(/10:42:31 +↑ 送出 +…/)
  expect(all).toContain('⋯ 等待回應中… 3 秒')

  // 沒有幫手的量就不出現那一行；列數少時只放得下最後幾筆
  const few = linesOf(sampleEntries(), 250, main, { sent: 0, received: 0 }, BASE + 31_500, 47, 10).map(textOf).join('\n')

  expect(few).not.toContain('幫手另計')
  expect(few).toContain('最近 2 筆，共 250 筆')
  expect(few).not.toContain('10:42:03')

  const failed: Entry = { sentAt: BASE, doneAt: BASE + 4_000, status: 'failed', sent: 0, cached: 0, received: 0, cost: 0 }

  expect(linesOf([failed], 1, main, helper, BASE + 5_000, 47, 40).map(textOf).join('\n')).toContain('✕ 中斷，沒收到帳單')
  expect(linesOf([], 0, { sent: 0, received: 0 }, { sent: 0, received: 0 }, 0, 47, 40).map(textOf).join('\n')).toContain('還沒有送出任何請求')
})

test('金額：合計靠右寫總花費、每筆寫約多少、其他另外寫；沒給 money 就一個錢字都沒有', async () => {
  const main = { sent: 1_284_530, received: 18_402 }
  const none = { sent: 0, received: 0 }
  const money = { spent: 1.274, other: 0.12 }

  for (const columns of [30, 47, 73]) {
    for (const line of linesOf(sampleEntries(), 3, main, none, BASE + 31_500, columns, 40, money)) {
      expect(widthOf(textOf(line))).toBeLessThanOrEqual(columns)
    }
  }

  const lines = linesOf(sampleEntries(), 3, main, none, BASE + 31_500, 47, 40, money).map(textOf)
  const all = lines.join('\n')

  expect(lines[1]).toMatch(/^合計 +↑ 送出 1,284,530 +↓ 收到 18,402 +\$1\.27$/)
  expect(widthOf(lines[1] ?? '')).toBe(47)
  // 沒有幫手的量也要有「其他」那一行，金額靠右
  expect(lines[2]).toMatch(/^ +其他約 \$0\.12$/)
  expect(all).toMatch(/10:42:11 +↓ 收到 +412 +約 \$0\.061/)
  // 還不知道金額的那筆不寫
  expect(all).toMatch(/10:42:30 +↓ 收到 +2,031$/m)

  // 欄寬很窄時，靠右的總花費留著
  expect(linesOf(sampleEntries(), 3, main, none, BASE + 31_500, 30, 40, money).map(textOf)[1]).toMatch(/\$1\.27$/)

  // 其他不到半美分就不寫那一行
  expect(linesOf(sampleEntries(), 3, main, none, BASE + 31_500, 47, 40, { spent: 1.274, other: 0.004 }).map(textOf).join('\n')).not.toContain('其他')

  // 中斷但有花到錢的那筆照樣寫金額；沒花到就不寫
  const cut: Entry = { sentAt: BASE, doneAt: BASE + 4_000, status: 'failed', sent: 0, cached: 0, received: 0, cost: 0.0123 }

  expect(linesOf([cut], 1, main, none, BASE + 5_000, 47, 40, money).map(textOf).join('\n')).toMatch(/✕ 中斷，沒收到帳單 +約 \$0\.012/)
  expect(linesOf([{ ...cut, status: 'done', cost: 0.0003 }], 1, main, none, BASE + 5_000, 47, 40, money).map(textOf).join('\n')).toContain('不到 $0.001')
  expect(linesOf([{ ...cut, cost: 0 }], 1, main, none, BASE + 5_000, 47, 40, money).map(textOf).join('\n')).not.toMatch(/帳單 +約/)

  expect(linesOf(sampleEntries(), 3, main, none, BASE + 31_500, 47, 40).map(textOf).join('\n')).not.toContain('$')
})

/** 把一個 turn.step 串流讀到底，回傳讀到的每一段和最後的結果。 */
async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<{ got: unknown[]; result: unknown }> {
  const got: unknown[] = []
  let read = await stream.next()

  while (read.done !== true) {
    got.push(read.value)
    read = await stream.next()
  }

  return { got, result: read.value }
}

test('回覆經過 mod 一段都不變；帳單記進主對話或幫手，中斷的標成中斷', async ($, on) => {
  const usage = {
    input_tokens: 10,
    output_tokens: 412,
    cache_read_input_tokens: 82_760,
    cache_creation_input_tokens: 2_550,
    model: 'claude-opus-5-5',
  }
  const chunks = [
    { kind: 'thinking', index: 0, text: '想一下' },
    { kind: 'text', index: 1, text: '你好' },
    { kind: 'stop', stopReason: 'end_turn', usage },
  ]
  let isAborting = false
  // 系統記的總花費：每次帳單到之前漲一點，跟真機一樣（stop 段到時已經含這一筆）
  let ledger = 0.5

  mock.clock(on)
  on('ui.invalidate', (_, e, next) => next(e))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.SessionStart', () => ({}) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: ledger } } as never }))
  on('turn.step', async function* (_, e) {
    if (isAborting) {
      yield { kind: 'text', index: 0, text: '寫到一半' } as never
      throw new Error('aborted')
    }

    for (const chunk of chunks) {
      if (chunk.kind === 'stop') {
        ledger += e.agentId === undefined ? 0.031 : 0.2
      }

      yield chunk as never
    }

    return { turnId: e.turnId, index: e.index, answer: '你好', toolUses: [], stopReason: 'end_turn', usage } as never
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'tokens',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tokens',
    props: {
      title: 'token',
      isFocused: false,
      bodyColumns: 47,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 38 },
      view: {},
    },
  })

  expect(await ui.find({ type: 'Text', text: /還沒有送出任何請求/ })).toBeDefined()

  const main = await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }) as never)

  expect(main.got).toEqual(chunks)
  expect(main.result).toMatchObject({ turnId: 't1', answer: '你好', stopReason: 'end_turn' } as never)
  expect(await ui.find({ type: 'Text', text: /↑ 送出 +85,320 +快取 97%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↓ 收到 +412 +約 \$0\.031/ })).toBeDefined()
  // 合計是系統的總花費（session 開始前已經花的 $0.50 也算），其他＝總花費減主對話那一筆
  expect(await ui.find({ type: 'Text', text: /↓ 收到 412 +\$0\.53/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /其他約 \$0\.50/ })).toBeDefined()

  // 幫手的請求也原樣通過，只加進「幫手另計」
  const helper = await drain($.turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1, agentId: 'h1' }) as never)

  expect(helper.got).toEqual(chunks)
  expect(await ui.find({ type: 'Text', text: /幫手另計 ↑ 85,320 +↓ 412.*其他約 \$0\.70/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$0\.73/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /共 1 筆/ })).toBeDefined()

  // 回覆中途出錯：那筆標成中斷，合計不變
  isAborting = true
  await expect(drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 3 }) as never)).rejects.toThrow()
  expect(await ui.find({ type: 'Text', text: /✕ 中斷，沒收到帳單/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /合計 +↑ 送出 85,320 +↓ 收到 412/ })).toBeDefined()

  // 按 Esc：外面讀到一半就不讀了，那筆也要標成中斷，不能一直等待中
  isAborting = false
  const stopped = $.turn.step({ turnId: 't3', index: 0, model: 'claude-opus-5-5', messageCount: 5 }) as AsyncGenerator<unknown, unknown>

  await stopped.next()
  expect(await ui.find({ type: 'Text', text: /等待回應中…/ })).toBeDefined()
  await stopped.return(undefined)
  expect(await ui.find({ type: 'Text', text: /等待回應中…/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /共 3 筆/ })).toBeDefined()

  // 引擎沒關掉串流、直接結束這一輪：還在等的那筆也要標成中斷
  const dangling = $.turn.step({ turnId: 't4', index: 0, model: 'claude-opus-5-5', messageCount: 7 }) as AsyncGenerator<unknown, unknown>

  await dangling.next()
  expect(await ui.find({ type: 'Text', text: /等待回應中…/ })).toBeDefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't4', reason: 'aborted' })
  expect(await ui.find({ type: 'Text', text: /等待回應中…/ })).toBeUndefined()

  // /clear：清單清空，總花費從 $0.00 起算
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(await ui.find({ type: 'Text', text: /還沒有送出任何請求/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↓ 收到 0 +\$0\.00/ })).toBeDefined()

  // 系統自己把總花費歸零（比 /clear 時記下的起點還小）：起點跟著歸零，照實顯示
  ledger = 0.01
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't5', reason: 'completed' } as never)
  expect(await ui.find({ type: 'Text', text: /↓ 收到 0 +\$0\.01/ })).toBeDefined()

  await ui.unmount()
})
