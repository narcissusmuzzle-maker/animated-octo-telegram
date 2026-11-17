// Служба «будильник»: её запускает система в момент окончания таймера, даже если экран погашен и приложение закрыто.
//  - вибрирует — ВСЕГДА, первым делом и без всяких проверок;
//  - сама ничего не ставит: все будильники (на несколько ближайших границ вперёд) расставляет страница, см. core.alarmPlan;
//  - пишет строку в журнал (файл lg_s.txt) ПОСЛЕ вибрации; любая ошибка журнала на вибрацию не влияет.
// Параметр: вид|граница в секундах (UTC)|сколько границ ещё впереди (-1 — без ограничения)|способ вибрации (A/B/C/D, нет — значит A).
//
// СПОСОБЫ ВИБРАЦИИ (диагностика: при погасшем экране вибрация то есть, то пропадает, хотя служба каждый раз пишет «ok»).
// В тестовом режиме способ чередуется по границам (core.methodFor), в обычном всегда A. Буква способа пишется в журнал.
//   A — как в версии 1.11.1: новый Vibrator, start({ mode: STRONG_REMINDER }) — серия из четырёх коротких (1200 мс).
//   B — другая сцена: setMode(DURATION_LONG) + start() — одна длинная (1000 мс), та самая, которой вибрирует страница при горящем экране.
//   C — как A, но служба потом «держит себя живой» около 2 секунд (пустой цикл), чтобы часы не успели заснуть / система не прибила службу
//       раньше, чем доиграет серия. После цикла пишется вторая строка «Z C …ms»: если её нет, значит службу прибили во время ожидания.
//   D — stop() перед запуском (сбросить возможное «незавершённое» состояние мотора), затем setMode(STRONG_REMINDER) + start().
// Служба живёт доли секунды (по документации система ограничивает разовый запуск ~600 мс), поэтому всё необязательное — после вибрации.
import * as sensor from '@zos/sensor'
import { readFileSync, writeFileSync } from '@zos/fs'
import { LocalStorage } from '@zos/storage'

const LOG_FILE = 'lg_s.txt'
const LOG_MAX = 80
const HOLD_MS = 2000

function scene(name) { return sensor[name] }

/** Вибрация выбранным способом. Возвращает { res: 'ok' | 'E:причина', m: номер сцены (для журнала) }. */
function buzz(method) {
  const sr = scene('VIBRATOR_SCENE_STRONG_REMINDER')
  const dl = scene('VIBRATOR_SCENE_DURATION_LONG')
  const mode = method === 'B' ? dl : sr
  let v = null
  try { v = new sensor.Vibrator() } catch (e) { return { res: 'E:noV ' + String(e).slice(0, 20), m: mode } }
  try {
    if (method === 'B') { v.setMode({ mode: mode }); v.start() }
    else if (method === 'D') { try { v.stop() } catch (e0) { /* нечего останавливать */ } v.setMode({ mode: mode }); v.start() }
    else v.start({ mode: mode })
    return { res: 'ok', m: mode }
  } catch (e) {
    try { v.setMode({ mode: mode }); v.start(); return { res: 'ok2', m: mode } } catch (e2) { return { res: 'E:' + String(e2).slice(0, 24), m: mode } }
  }
}

/** Дописать строку в журнал службы (последние LOG_MAX). Формат строки: «миллисекунды|текст». */
function logLine(ms, text) {
  try {
    let old = ''
    try { old = readFileSync({ path: LOG_FILE, options: { encoding: 'utf8' } }) } catch (e) { old = '' }
    const lines = typeof old === 'string' && old ? old.split('\n').filter((s) => s.indexOf('|') > 0) : []
    lines.push(Math.round(ms) + '|' + String(text).replace(/[\r\n|]+/g, ' '))
    const cut = lines.length > LOG_MAX ? lines.slice(lines.length - LOG_MAX) : lines
    writeFileSync({ path: LOG_FILE, data: cut.join('\n') + '\n', options: { encoding: 'utf8' } })
  } catch (e) { /* журнал не критичен */ }
}

/** Сколько секунд назад страница в последний раз «тикала» (она пишет метку каждые 2 секунды, пока экран горит): сколько часы «спят». */
function frozenFor(now) {
  try {
    const ls = new LocalStorage()
    const hb = +ls.getItem('hb', '')
    if (hb > 1000000000000) return ' f' + Math.min(999, Math.max(0, Math.round((now - hb) / 1000)))
  } catch (e) { /* без метки */ }
  return ''
}

/** Пустой цикл: держит службу живой. Возвращает, сколько миллисекунд прошло. */
function hold(ms) {
  const t0 = Date.now()
  let n = 0
  while (Date.now() - t0 < ms) n++
  return Date.now() - t0
}

AppService({
  onInit(param) {
    const now = Date.now()
    const parts = String(param || '').split('|')
    const method = parts[3] === 'B' || parts[3] === 'C' || parts[3] === 'D' ? parts[3] : 'A'
    const r = buzz(method)
    try {
      const kind = parts[0] || '?'
      let b = +parts[1] || 0
      if (b < 1000000000) b = 0   // старый вид параметра: вместо границы там было «поколение»
      const late = b ? ' +' + Math.round(now / 1000 - b) + 's' : ''
      const m = r.m === undefined ? '?' : r.m
      logLine(now, 'S ' + kind + late + ' ' + method + ' m' + m + ' ' + r.res + frozenFor(now))
    } catch (e) { /* журнал не критичен */ }
    if (method === 'C') {
      const dt = hold(HOLD_MS)
      logLine(Date.now(), 'Z C ' + dt + 'ms')
    }
  },
  onDestroy() {}
})
