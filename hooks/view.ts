/** 一行裡的一小段字，帶自己的顏色與粗細。 */
export type Segment = {
  /** 要顯示的字。 */
  text: string
  /** 顏色，`#rrggbb`；沒給就是終端機預設字色。 */
  color?: string
  /** 粗體。 */
  bold?: boolean
  /** 暗一階，給次要資訊用。 */
  dim?: boolean
}

/** 畫面上的一行：由左到右排的幾段字；空陣列是空白行。 */
export type Line = Segment[]

/** 一次送給 Anthropic 的請求（只記主對話的）。時間都是毫秒（Date.now() 的值）。 */
export type Entry = {
  /** 送出的時間。 */
  sentAt: number
  /** 收完或中斷的時間；還在等是 null。 */
  doneAt: number | null
  /** 還在等、收完了、還是中斷了（被打斷或出錯，沒拿到帳單）。 */
  status: 'waiting' | 'done' | 'failed'
  /** 整包送出的 token 數（沒快取的＋快取讀到的＋寫進快取的）；收完才知道，之前是 0。 */
  sent: number
  /** 送出的量裡面，Anthropic 已經記住、從快取讀的部分。 */
  cached: number
  /** 收到的 token 數（模型想的部分也算在裡面）。 */
  received: number
  /** 這一筆大約花了幾美金（送出前後系統總花費的差）；還不知道、或系統沒有記花費時是 null。 */
  cost: number | null
}

/** 送出與收到的累計。 */
export type Totals = {
  /** 送出的 token 數。 */
  sent: number
  /** 收到的 token 數。 */
  received: number
}

/** 花費的兩個數字，美金。 */
export type Money = {
  /** 這段對話到目前的總花費，跟 /cost 一樣（/clear 之後從 0 算起）。 */
  spent: number
  /** 總花費裡不是主對話的請求花的：幫手、壓縮對話、其他 mod 自己發的請求。從清單丟掉的舊筆不算在這裡。 */
  other: number
}

/** API 帳單上的四個數字，欄位名稱照 API 的寫法。 */
export type Usage = {
  /** 沒用到快取的輸入。 */
  input_tokens: number
  /** 模型產生的輸出。 */
  output_tokens: number
  /** 從快取讀到的輸入。 */
  cache_read_input_tokens: number
  /** 這次寫進快取的輸入。 */
  cache_creation_input_tokens: number
}

const SENT_COLOR = '#5fafd7'
const RECEIVED_COLOR = '#87d787'
const WAITING_COLOR = '#d7af5f'
const FAILED_COLOR = '#d75f5f'
// 時間欄的寬度（「10:42:03」加兩格空白），等待那一行用同樣寬的空白對齊
const TIME_COLUMN = 10
// 一筆佔的列數：送出、等待、收到，加一行空白
const ROWS_PER_ENTRY = 4

/**
 * 【行為】一段字在終端機佔幾格寬：中日韓文字、全形標點、表情符號算 2 格，其他算 1 格。
 *   跟 ctx-panel、files、timeline 的同名函式一樣。
 */
export function widthOf(text: string): number {
  let width = 0

  for (const glyph of text) {
    const code = glyph.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    width += isWide ? 2 : 1
  }

  return width
}

/** 【行為】把一段字裁到最多 max 格寬，超過時留開頭、結尾補「…」；放得下就原樣回傳，max 小於 1 回空字串。 */
export function fit(text: string, max: number): string {
  if (widthOf(text) <= max) {
    return text
  }

  if (max < 1) {
    return ''
  }

  let kept = ''

  for (const glyph of text) {
    if (widthOf(kept + glyph) > max - 1) {
      break
    }

    kept += glyph
  }

  return `${kept}…`
}

/** 【行為】整數加千分位逗號：1284530 → 「1,284,530」。小數無條件捨去，負數當 0。 */
export function countOf(n: number): string {
  return `${Math.max(0, Math.floor(n))}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 【行為】美金寫成「$0.031」：小數點後 digits 位（四捨五入），負數當 0。 */
export function usdOf(n: number, digits: number): string {
  return `$${Math.max(0, n).toFixed(digits)}`
}

/** 【行為】把毫秒時間戳寫成本機時區的「時:分:秒」，24 小時制、兩位數補零，例如「09:05:03」。 */
export function timeOf(at: number): string {
  const date = new Date(at)
  const two = (n: number) => `${n}`.padStart(2, '0')

  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/**
 * 【行為】把等了多久寫成白話：不到 60 秒是「8.2 秒」（一位小數，無條件捨去），60 秒以上是「1 分 05 秒」。
 *   isLive 為 true（還在等、每秒跳）時不寫小數：「3 秒」。負數當 0。
 */
export function durationOf(ms: number, isLive = false): string {
  const safe = Math.max(0, ms)
  const seconds = Math.floor(safe / 1000)

  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)} 分 ${`${seconds % 60}`.padStart(2, '0')} 秒`
  }

  return isLive ? `${seconds} 秒` : `${(Math.floor(safe / 100) / 10).toFixed(1)} 秒`
}

/** 【行為】帳單上整包送出的量：沒快取的＋快取讀到的＋寫進快取的。 */
export function sentOf(usage: Usage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

/** 寬度不一定的字，左邊補空白補到 width 格寬。 */
function padStartWidth(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - widthOf(text))) + text
}

/** 幾段字由左到右排，超過 columns 就從超出的那段開始裁；有 right 就靠右放，中間補空白。 */
function line(left: Segment[], right: Segment | undefined, columns: number): Line {
  const room = right === undefined ? columns : Math.max(0, columns - widthOf(right.text) - 1)
  const kept: Segment[] = []
  let used = 0

  for (const segment of left) {
    if (room - used <= 0) {
      break
    }

    const text = fit(segment.text, room - used)

    if (text !== '') {
      kept.push({ ...segment, text })
      used += widthOf(text)
    }
  }

  if (right === undefined || room <= 0) {
    return kept
  }

  return [...kept, { text: ' '.repeat(Math.max(1, columns - used - widthOf(right.text))) }, right]
}

/** 一筆請求畫成的幾行（不含後面的空白行）。 */
function entryLines(entry: Entry, now: number, columns: number, isCostShown: boolean): Line[] {
  const indent = ' '.repeat(TIME_COLUMN)
  const lines: Line[] = []
  const sentText = entry.status === 'done' ? padStartWidth(countOf(entry.sent), 10) : `${' '.repeat(5)}…`
  const share = entry.status === 'done' && entry.sent > 0 ? `   快取 ${Math.round((entry.cached / entry.sent) * 100)}%` : ''

  lines.push(
    line(
      [
        { text: `${timeOf(entry.sentAt)}  ` },
        { text: '↑ 送出', color: SENT_COLOR, bold: true },
        { text: sentText },
        { text: share, dim: true },
      ],
      undefined,
      columns,
    ),
  )

  if (entry.doneAt === null) {
    lines.push(
      line([{ text: indent }, { text: `⋯ 等待回應中… ${durationOf(now - entry.sentAt, true)}`, color: WAITING_COLOR }], undefined, columns),
    )

    return lines
  }

  lines.push(line([{ text: indent }, { text: `⋯ 等待回應 ${durationOf(entry.doneAt - entry.sentAt)}`, dim: true }], undefined, columns))

  // 中斷的那筆只有真的花了錢才寫金額
  const cost: Segment | undefined =
    !isCostShown || entry.cost === null || (entry.status === 'failed' && entry.cost <= 0)
      ? undefined
      : { text: entry.cost < 0.0005 ? '不到 $0.001' : `約 ${usdOf(entry.cost, 3)}`, dim: true }

  if (entry.status === 'done') {
    lines.push(
      line(
        [
          { text: `${timeOf(entry.doneAt)}  ` },
          { text: '↓ 收到', color: RECEIVED_COLOR, bold: true },
          { text: padStartWidth(countOf(entry.received), 10) },
        ],
        cost,
        columns,
      ),
    )
  } else {
    lines.push(line([{ text: `${timeOf(entry.doneAt)}  ` }, { text: '✕ 中斷，沒收到帳單', color: FAILED_COLOR }], cost, columns))
  }

  return lines
}

/**
 * 【何時能呼叫】columns 至少 40 才排得好看；更窄也不會壞，只是字會被裁掉。rows 是側邊欄可用的列數。
 * 【行為】把 token 往來排成側邊欄的每一行，每一行都不超過 columns 格寬。
 *   最上面是標題（右邊是「最近幾筆，共幾筆」）、主對話送出與收到的合計；然後一條分隔線。
 *   有給 money 時，合計那一行靠右寫總花費（小數兩位），沒給就不寫任何金額。
 *   helper 有任何量、或 money.other 至少 0.005 美金時，合計下面多一行：左邊「幫手另計」的 token 數（helper 有量才寫），
 *   右邊「其他約 $0.12」（other 夠大才寫）。
 *   entries 是空的時候寫「還沒有送出任何請求」。否則照時間先後列最後幾筆（最新的在最下面），
 *   放得下幾筆看 rows 扣掉上面幾行還剩多少，最少 1 筆；每筆是送出、等待、收到三行，筆跟筆之間空一行。
 *   還在等的那筆：送出的數字是「…」、等待那行寫「等待回應中… N 秒」，沒有收到那行。
 *   中斷的那筆：送出的數字是「…」、收到那行改成「✕ 中斷，沒收到帳單」。
 *   每一筆的 cost 不是 null 時，收到那行靠右寫「約 $0.031」（小數三位），不到 0.0005 寫「不到 $0.001」；
 *   中斷的那筆只有 cost 大於 0 才寫。
 *   欄寬不夠時先裁左邊的字，靠右的金額保留。
 *   total 是全部記過的筆數（含已經從 entries 丟掉的舊筆）。now 是現在的時間，毫秒。
 */
export function linesOf(
  entries: readonly Entry[],
  total: number,
  main: Totals,
  helper: Totals,
  now: number,
  columns: number,
  rows: number,
  money?: Money,
): Line[] {
  const isHelperShown = helper.sent > 0 || helper.received > 0
  // 不到半美分寫出來會是「$0.00」，不如不寫
  const isOtherShown = money !== undefined && money.other >= 0.005
  const headerRows = isHelperShown || isOtherShown ? 4 : 3
  // 最後一筆後面不用空白行，所以多算 1 列
  const room = Math.max(1, Math.floor((rows - headerRows + 1) / ROWS_PER_ENTRY))
  const shown = entries.slice(-room)
  const lines: Line[] = [
    line(
      [{ text: 'Token 往來', bold: true }],
      entries.length === 0 ? undefined : { text: `最近 ${shown.length} 筆，共 ${total} 筆`, dim: true },
      columns,
    ),
    line(
      [
        { text: '合計  ' },
        { text: '↑ 送出 ', color: SENT_COLOR },
        { text: `${countOf(main.sent)}   ` },
        { text: '↓ 收到 ', color: RECEIVED_COLOR },
        { text: countOf(main.received) },
      ],
      money === undefined ? undefined : { text: usdOf(money.spent, 2), bold: true },
      columns,
    ),
  ]

  if (isHelperShown || isOtherShown) {
    lines.push(
      line(
        isHelperShown ? [{ text: `（幫手另計 ↑ ${countOf(helper.sent)}  ↓ ${countOf(helper.received)}）`, dim: true }] : [],
        isOtherShown ? { text: `其他約 ${usdOf(money.other, 2)}`, dim: true } : undefined,
        columns,
      ),
    )
  }

  lines.push([{ text: '─'.repeat(Math.max(0, columns)), dim: true }])

  if (entries.length === 0) {
    lines.push([{ text: fit('還沒有送出任何請求', columns), dim: true }])

    return lines
  }

  shown.forEach((entry, at) => {
    if (at > 0) {
      lines.push([])
    }

    lines.push(...entryLines(entry, now, columns, money !== undefined))
  })

  return lines
}

// #region AI-NOTES
// AI-NOTES：agent 專用備忘。當時為真、非契約、非指令；改到相關程式碼時重驗，錯了就刪。
// 2026-10-03 widthOf、fit 從 timeline 複製；mod 之間不能互相 import。
// 2026-10-03 「送出」= input + cache_read + cache_creation，是整包送過去的量；只有 input 那部分是沒快取的。
//   主人看的是「送了多少」不是「付了多少」，所以不分開列，只用「快取 N%」標出已經記住的比例；錢另外用 Money 顯示。
// 2026-10-03 符號只用 ↑ ↓ ⋯ ✕ ─：沙漏 ⏳ 在終端機佔 2 格，但 widthOf 會算成 1 格，對不齊，所以等待中只換顏色不換符號。
// #endregion
