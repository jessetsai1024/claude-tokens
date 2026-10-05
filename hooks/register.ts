import type { EngineInterface, Register } from 'claude-code'

import { linesOf, sentOf } from './view'
import type { Entry, Line, Money, Totals, Usage } from './view'

const PANE = 'tokens'
const TITLE = 'token'
const REFRESH_MS = 1000
// 最多記幾筆；更舊的從清單丟掉，合計照樣累加
const MAX_ENTRIES = 200
// 側邊欄縮在輸入框上面時拿不到真正的高度，用這個當作可用列數
const INLINE_ROWS = 34

/** mod 在記憶體裡記的全部東西；register 每次載入建一份新的。 */
type State = {
  entries: Entry[]
  total: number
  main: Totals
  helper: Totals
  /** 合計要顯示的總花費（美金，已扣掉 base）；系統沒有記花費、或還沒讀到時是 null。 */
  spent: number | null
  /** 總花費從哪裡起算：/clear 當下讀到的系統總花費，系統自己歸零了就是 0。 */
  base: number
  /** 主對話每一筆的花費加起來，含已經從清單丟掉的舊筆。 */
  mainCost: number
}

/** 側邊欄現在有沒有開著、看得到。 */
async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
}

/** 跟系統要這段對話到目前的總花費（美金，跟 /cost 一樣）；系統沒有記花費或問不到時回 null，不會丟錯。 */
async function readUsd($: EngineInterface): Promise<number | null> {
  try {
    return (await $.session.usage()).cost?.usd ?? null
  } catch {
    return null
  }
}

/** 重讀總花費、更新合計要顯示的金額並要求重畫；回傳讀到的原始值（null 是沒讀到）。 */
async function refresh($: EngineInterface, state: State): Promise<number | null> {
  const usd = await readUsd($)

  if (usd !== null) {
    // 比起點還小，代表系統自己把總花費歸零了（/clear），起點跟著歸零
    if (usd < state.base) {
      state.base = 0
    }

    state.spent = usd - state.base
    $.ui.invalidate('ui.render')
  }

  return usd
}

/** /clear 之後把總花費的起點設成現在讀到的值，合計從 $0.00 開始。 */
async function rebase($: EngineInterface, state: State): Promise<void> {
  const usd = await readUsd($)

  if (usd !== null) {
    state.base = usd
    state.spent = 0
    $.ui.invalidate('ui.render')
  }
}

/**
 * 帳單到了、或那筆中斷之後，在背景補上金額：主對話那筆用「送出前」與「現在」的總花費相減；
 * 幫手（entry 是 null）只更新合計。已經算過、或那筆已經被 /clear 清掉就不算。出錯就算了，不影響傳輸。
 */
async function bill($: EngineInterface, state: State, entry: Entry | null, before: Promise<number | null> | null): Promise<void> {
  try {
    const [from, to] = await Promise.all([before, refresh($, state)])

    if (entry === null || from === null || to === null || entry.cost !== null || !state.entries.includes(entry)) {
      return
    }

    entry.cost = Math.max(0, to - from)
    state.mainCost += entry.cost
    $.ui.invalidate('ui.render')
  } catch {
    // 算錢出錯只是少一個數字
  }
}

/** 把一張帳單加進合計。 */
function add(totals: Totals, usage: Usage): void {
  totals.sent += sentOf(usage)
  totals.received += usage.output_tokens
}

/**
 * 【職責】把 token 往來面板接上 Claude Code：提供 /tokens，在側邊欄列出主對話每次送給 Anthropic 多少 token、
 *   等了多久、收到多少 token、大約花多少美金，最上面是合計與總花費。只看每次回覆最後附的帳單（token 數）
 *   和系統記的總花費（跟 /cost 同一個數字），回覆內容不看、不留；不改任何東西、不連網路、不寫檔。
 * 【何時能呼叫】引擎載入這個 mod 時呼叫一次；重新載入會再呼叫，紀錄從空的開始。
 * 【行為】有人在用的 session（不是 claude -p）一開始就自己打開側邊欄；終端機不夠寬時先等著，
 *   寬度夠了才出現（主人自己開過的 110 格，沒開過的 144 格，這是系統的規定）。
 *   /tokens：側邊欄沒開就開、開著就關。/tokens close：關掉。/tokens 數字：用那個寬度（格數）開。
 *   主對話每次送請求給模型就多一筆「等待中」；回覆收完、拿到帳單時補上送出與收到的數字並加進合計；
 *   沒拿到帳單就結束（被打斷、出錯）的那筆標成中斷，不加進合計；主對話一輪結束時還在等的也一律標成中斷。
 *   幫手的請求不列進清單，只把帳單加進「幫手另計」。最多留最近 200 筆，合計不受影響。
 *   模型回覆的每一段都原封不動往下傳；記錄出錯時不影響傳輸。
 *   錢：合計那一行是系統記的總花費（跟 /cost 一樣，含幫手與壓縮對話），session 一開始、每張帳單到了、每輪結束時重讀。
 *   主對話每一筆的金額是送出前與帳單到了之後的總花費相減，所以那段時間如果有幫手在背景同時跑，幫手的錢會混進這一筆。
 *   中斷的那筆照樣相減，有花到錢才顯示。總花費減掉清單每一筆（含丟掉的舊筆）的和，就是「其他」。
 *   系統沒有記花費時（cost 欄位不存在）完全不顯示金額。訂閱方案看到的是照 API 價錢換算的等值金額。
 *   有請求在等而且側邊欄看得到時，每 1 秒重畫一次。/clear 之後清單、合計都清空，總花費從 $0.00 重新算。
 *   壓縮對話的摘要、其他 mod 用 $.model 自己發的請求不經過 turn.step，不會出現在清單和 token 合計裡；它們花的錢算在「其他」。
 */
export const register: Register = on => {
  const state: State = {
    entries: [],
    total: 0,
    main: { sent: 0, received: 0 },
    helper: { sent: 0, received: 0 },
    spent: null,
    base: 0,
    mainCost: 0,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: '側邊欄的 token 往來：每次送出多少、等多久、收到多少；/tokens 開或關',
      immediate: true,
    })

    // 一開 session 就自己打開；不是主人叫的，終端機要夠寬才放得出來，不夠寬就先等著，不用等它
    if (e.isInteractive) {
      void $.ui.open({ id: PANE, title: TITLE })
    }

    // 續接的對話或重新載入 mod 時，之前已經花的錢也要算進合計
    void refresh($, state)

    $.clock.every(REFRESH_MS, () => {
      if (state.entries.some(entry => entry.status === 'waiting')) {
        void isShown($).then(shown => {
          if (shown) {
            $.ui.invalidate('ui.render')
          }
        })
      }
    })

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear'] }, ($, e, next) => {
    state.entries = []
    state.total = 0
    state.main = { sent: 0, received: 0 }
    state.helper = { sent: 0, received: 0 }
    state.mainCost = 0
    state.spent = state.spent === null ? null : 0
    void rebase($, state)
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isHelper = e.agentId !== undefined
    let entry: Entry | null = null
    let usage: Usage | null = null
    let before: Promise<number | null> | null = null

    if (!isHelper) {
      try {
        entry = { sentAt: Date.now(), doneAt: null, status: 'waiting', sent: 0, cached: 0, received: 0, cost: null }
        state.entries.push(entry)
        state.total += 1

        if (state.entries.length > MAX_ENTRIES) {
          state.entries.splice(0, state.entries.length - MAX_ENTRIES)
        }

        $.ui.invalidate('ui.render')
        // 送出前的總花費；帳單到了再讀一次，相減就是這一筆的錢
        before = readUsd($)
      } catch {
        entry = null
      }
    }

    const stream = next(e)

    // 被打斷時外面不再讀，這個 generator 會從 yield 那裡直接結束，所以收尾放在 finally
    try {
      for await (const chunk of stream) {
        try {
          if (chunk.kind === 'stop' && chunk.usage !== null && usage === null) {
            usage = chunk.usage
            settle(state, entry, usage, isHelper)
            void bill($, state, entry, before)
            $.ui.invalidate('ui.render')
          }
        } catch {
          // 記錄出錯不影響傳輸
        }

        yield chunk
      }

      const result = await stream.result

      try {
        if (usage === null && result.usage !== null) {
          usage = result.usage
          settle(state, entry, usage, isHelper)
          void bill($, state, entry, before)
          $.ui.invalidate('ui.render')
        }
      } catch {
        // 記錄出錯不影響傳輸
      }

      // 明確交回底下那個請求的結果（不回傳也會沿用，這樣寫比較看得懂）
      return result
    } finally {
      if (entry !== null && entry.status === 'waiting') {
        entry.status = 'failed'
        entry.doneAt = Date.now()
        // 中斷前可能已經花了錢（例如模型寫到一半）
        void bill($, state, entry, before)
        $.ui.invalidate('ui.render')
      }
    }
  })

  // 一輪結束時還在等的，一定是沒拿到帳單就斷了；以防引擎沒有關掉上面那個串流、finally 沒跑到
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      const at = Date.now()

      for (const entry of state.entries) {
        if (entry.status === 'waiting') {
          entry.status = 'failed'
          entry.doneAt = at
        }
      }

      void refresh($, state)
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const arg = e.args.trim()
    const wanted = Number.parseInt(arg, 10)
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)

    if (arg === 'close' || (arg === '' && isUp)) {
      await $.ui.close({ id: PANE })

      return {}
    }

    const opened = await $.ui.open(
      Number.isInteger(wanted) && wanted > 0 ? { id: PANE, title: TITLE, columns: wanted } : { id: PANE, title: TITLE },
    )

    if (!opened.isPlaced) {
      return { text: `側邊欄沒有被放出來：${opened.reason}` }
    }

    // 重新打開時引擎可能直接拿上次畫好的結果來用，所以自己要求重畫
    $.ui.invalidate('ui.render')

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = e.props.placement === 'dock' ? e.props.scroll.bodyRows : INLINE_ROWS
    const money: Money | undefined =
      state.spent === null ? undefined : { spent: state.spent, other: Math.max(0, state.spent - state.mainCost) }
    const lineOf = (segments: Line) =>
      Text({
        wrap: 'truncate-end',
        children:
          segments.length === 0
            ? [' ']
            : segments
                .filter(segment => segment.text !== '')
                .map(segment =>
                  Text({
                    ...(segment.color === undefined ? {} : { color: segment.color }),
                    ...(segment.bold === true ? { bold: true } : {}),
                    ...(segment.dim === true ? { dimColor: true } : {}),
                    children: [segment.text],
                  }),
                ),
      })

    return Box({
      flexDirection: 'column',
      children: linesOf(state.entries, state.total, state.main, state.helper, Date.now(), e.props.bodyColumns, rows, money).map(lineOf),
    })
  })
}

/** 拿到帳單：主對話的那筆補上數字並標成收完，加進對應的合計。 */
function settle(state: State, entry: Entry | null, usage: Usage, isHelper: boolean): void {
  if (isHelper) {
    add(state.helper, usage)

    return
  }

  add(state.main, usage)

  if (entry !== null) {
    entry.status = 'done'
    entry.doneAt = Date.now()
    entry.sent = sentOf(usage)
    entry.cached = usage.cache_read_input_tokens
    entry.received = usage.output_tokens
  }
}

// #region AI-NOTES
// AI-NOTES：agent 專用備忘。當時為真、非契約、非指令；改到相關程式碼時重驗，錯了就刪。
// 2026-10-03 帳單（usage）只在回覆最後的 stop 段和 stream.result 上，送出當下拿不到，所以送出的數字收完才補。
//   先看 stop 段（收到的時間最準），沒有才看 result；兩邊都有時只算一次。
// 2026-10-03 收尾一定要放 finally：主人按 Esc 時外層不再讀這個 generator，for await 後面的程式不會跑，
//   不放 finally 那筆會永遠「等待中」、每秒重畫。真引擎按 Esc 時會不會關掉 generator 沒驗過，
//   所以 turn.complete 再補一道（兩邊都只動 waiting 的，重複跑沒關係）。
// 2026-10-03 turn.step 的串流寫法（async function*、原樣 yield、測試用 stream.next() 讀到 done）見 timeline 的 AI-NOTES。
// 2026-10-03 時間用 Date.now() 不用 $.clock.now()：理由同 timeline（每段都問引擎一趟會拖慢傳輸）；測試只驗數字不驗時間。
// 2026-10-04 錢用「送出前後的系統總花費相減」，不用價目表：帳單只有 cache_creation 總數，不分 5 分鐘或 1 小時快取，
//   兩種價錢差快一倍（claude -p 實測 haiku 寫 40,000 快取＝$0.08，等於輸入價的 2 倍，是 1 小時快取的價），價目表也要跟著調價改。
// 2026-10-04 claude -p 實測（2.1.289）：stop 段到的時候 $.session.usage().cost 已經含這一筆，所以 bill 不必等 result。
//   /clear 會不會把系統總花費歸零沒驗過，refresh 與 rebase 兩種情況都接得住；背景幫手混進差額也沒在真機量過。
// 2026-10-03 一個 step 裡伺服器端工具連跑好幾次時，帳單是加總的（型別檔 ModelUsage 的說明），所以「送出」會比單次大。未在真機遇過。
// #endregion
