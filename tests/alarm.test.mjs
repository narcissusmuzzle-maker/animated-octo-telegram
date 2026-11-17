// Модель системы будильников: проверяем, что на каждой границе занятия сработает служба (вибрация) — и когда страница открывается
// на каждой границе, и когда не открывается совсем, и когда система отказывает в будильнике на занятую секунду.
import assert from 'node:assert'
import * as core from '../shared/core.js'
import * as dlog from '../shared/dlog.js'

const T = 1700000000000   // начало, мс (кратно секунде)
let n = 0
function t(name, f) { f(); n++; console.log('ok  ' + name) }

/** Поставить занятие и гонять модель secs секунд. opts: pageOpens, reject (отказ на занятую секунду для той же службы), stopAt (сек), auto (очередь). */
function run(opts) {
  const o = Object.assign({ pageOpens: true, reject: false, secs: 260, stopAt: -1, queue: null }, opts)
  const st = core.newState(true, 60)
  let nextId = 100
  let pending = []
  let stored = []
  const vib = []
  const api = {
    set(url, param, delay) {
      const at = nowMs + delay * 1000
      if (o.reject && pending.some((a) => a.url === url && Math.floor(a.at / 1000) === Math.floor(at / 1000))) return 0
      const id = nextId++
      pending.push({ id: id, url: url, param: param, at: at })
      return id
    },
    cancel(id) { pending = pending.filter((a) => a.id !== id) }
  }
  let nowMs = T
  function settle() {
    core.process(st, nowMs)
    const r = core.applyAlarms(st, nowMs, stored, api)
    stored = r.next
  }
  if (o.queue) { st.queue = o.queue.slice(); core.startAuto(st, T) } else core.toggle(st, 0, T)
  settle()
  for (nowMs = T; nowMs <= T + o.secs * 1000; nowMs += 100) {
    if (o.stopAt >= 0 && nowMs === T + o.stopAt * 1000) { core.toggle(st, 0, nowMs); settle() }
    const due = pending.filter((a) => a.at <= nowMs).sort((a, b) => a.at - b.at)
    for (const a of due) {
      pending = pending.filter((x) => x !== a)
      if (a.url === 'app-service/alarm') vib.push({ t: nowMs, b: +a.param.split('|')[1] })
      else if (o.pageOpens) settle()
    }
  }
  return { vib: vib, st: st, pending: pending }
}

/** На каждой границе (кроме последних секунд модели) есть вибрация службы не позже чем через 3,5 секунды. */
function covered(r, first, last) {
  const miss = []
  for (let j = first; j <= last; j++) {
    const b = T + j * 20000
    const ok = r.vib.some((v) => v.t - b >= 0 && v.t - b <= 3500)
    if (!ok) miss.push(j)
  }
  return miss
}

t('страница открывается на каждой границе: вибрация службы на каждой из 12 границ за четыре минуты, ровно по одной', () => {
  const r = run({})
  assert.deepEqual(covered(r, 1, 12), [])
  assert.equal(r.vib.length, 12)
})

t('система отказывает в будильнике на занятую секунду: всё равно вибрирует на каждой границе', () => {
  const r = run({ reject: true })
  assert.deepEqual(covered(r, 1, 12), [])
})

t('страница не открывается совсем: службы хватает на всё окно вперёд (в тесте 24 границы = 8 минут), дальше — тишина', () => {
  const r = run({ pageOpens: false, secs: 600 })
  assert.deepEqual(covered(r, 1, core.ALARM_AHEAD_TEST), [])
  assert.equal(r.vib.length, core.ALARM_AHEAD_TEST)
})

t('обычный режим (не тест): окно 12 границ, способ вибрации всегда A', () => {
  const st = core.newState(false, 60)
  core.toggle(st, 0, T)
  const p = core.alarmPlan(st, core.aheadFor(st)).filter((x) => x.url === 'app-service/alarm')
  assert.equal(p.length, core.ALARM_AHEAD)
  assert.equal(p.every((x) => x.param.split('|')[3] === 'A'), true)
})

t('остановка занятия снимает все будильники: после неё вибрации нет', () => {
  const r = run({ stopAt: 25, secs: 90 })
  assert.equal(r.vib.length, 1)               // граница на 20-й секунде (следующая — на 40-й)
  assert.equal(r.pending.length, 0)
  assert.equal(r.vib.every((v) => v.t < T + 25000), true)
})

t('автостарт: служба на каждую границу очереди и ни одной лишней', () => {
  const r = run({ queue: ['🧬', '💀', '🩸', '🤖'], secs: 200 })
  assert.deepEqual(covered(r, 1, 4), [])
  assert.equal(r.vib.length, 4)
  assert.equal(r.st.auto, false)
})

t('план будильников: окно из ALARM_AHEAD границ вперёд, у каждого свой ключ, страница — только на ближайшую', () => {
  const st = core.newState(true, 60)
  core.toggle(st, 0, T)
  const p = core.alarmPlan(st, 3)
  const s = p.filter((x) => x.url === 'app-service/alarm')
  const g = p.filter((x) => x.url === 'page/index')
  assert.equal(s.length, 3)
  assert.equal(g.length, 1)
  assert.deepEqual(s.map((x) => x.at), [T / 1000 + 21, T / 1000 + 41, T / 1000 + 61])
  assert.equal(g[0].at, T / 1000 + 24)
  assert.equal(new Set(p.map((x) => x.key)).size, p.length)
  // ничего не идёт — плана нет
  assert.equal(core.alarmPlan(core.newState(false, 60), 3).length, 0)
})

t('сравнение с уже стоящим: оставляем нужное, снимаем лишнее и старый формат (число вместо объекта)', () => {
  const st = core.newState(true, 60)
  core.toggle(st, 0, T)
  const plan = core.alarmPlan(st, 3)
  const old = [{ k: plan[0].key, i: 5 }, { k: 'sxxx', i: 6 }, 77, { k: plan[0].key, i: 8 }]
  const d = core.alarmDiff(old, plan)
  assert.deepEqual(d.kept.map((x) => x.i), [5])
  assert.deepEqual(d.cancel, [6, 77, 8])
  assert.equal(d.add.length, plan.length - 1)
})

t('журнал: запись, обрезка до последних, слияние по времени, страницы, итог, разбор мусора', () => {
  let a = ''
  for (let k = 1; k <= 5; k++) a = dlog.append(a, 1000 * k, 'S hour +1s ok', 3)
  assert.equal(dlog.parse(a).length, 3)
  assert.equal(dlog.parse(a)[0].t, 3000)
  const s = dlog.parse(dlog.append('', 2500, 'P open alarm', 10))
  const m = dlog.merge(dlog.parse(a), s)
  assert.deepEqual(m.map((x) => x.t), [2500, 3000, 4000, 5000])
  assert.deepEqual(dlog.parse('мусор\n|без времени\nabc|x\n12|ok\n').length, 1)
  const pg = dlog.pageOf(m, 0, 3)
  assert.equal(pg.rows.length, 3)
  assert.equal(pg.pages, 2)
  assert.equal(dlog.pageOf(m, 5, 3).page, 1)   // номер страницы за краем прижимается
  const e = [{ t: 1, text: 'S hour +1s ok' }, { t: 2, text: 'S hour +2s E:noV' }, { t: 3, text: 'P open alarm' }, { t: 4, text: 'A s7:X(id0)' }]
  assert.deepEqual(dlog.summary(e), { s: 2, e: 2, p: 1 })
  assert.equal(dlog.kindOf('S hour +1s ok'), 'svc')
  assert.equal(dlog.kindOf('PV E:x'), 'err')
  assert.equal(dlog.kindOf('P open -'), 'page')
  assert.ok(dlog.line({ t: 1700000000000, text: 'x'.repeat(80) }).length <= 8 + 1 + dlog.TEXT_MAX)
})

t('способы вибрации в тесте чередуются A B C D по границам и не зависят от пересчёта плана; в параметре — четвёртым полем', () => {
  const st = core.newState(true, 60)
  core.toggle(st, 0, T)
  const p1 = core.alarmPlan(st, core.aheadFor(st)).filter((x) => x.url === 'app-service/alarm')
  assert.equal(p1.length, core.ALARM_AHEAD_TEST)
  const letters = p1.map((x) => x.param.split('|')[3])
  assert.deepEqual(letters.slice(0, 4).slice().sort(), ['A', 'B', 'C', 'D'])   // четыре подряд — все четыре способа
  for (let k = 4; k < letters.length; k++) assert.equal(letters[k], letters[k - 4])
  // через минуту (границы 1-3 прошли) у тех же границ те же способы
  const p2 = core.alarmPlan(st, core.aheadFor(st)).filter((x) => x.url === 'app-service/alarm')
  const byB = {}
  for (const x of p1) byB[x.param.split('|')[1]] = x.param.split('|')[3]
  for (const x of p2) assert.equal(byB[x.param.split('|')[1]], x.param.split('|')[3])
})

t('сводка журнала: номера и буквы после последней записи T start; ! — ошибка, ? — у C нет строки Z', () => {
  const e = [
    { t: 1, text: 'S hour +1s A m24 ok f5' },       // до метки — не считается
    { t: 10, text: 'T start 20s' },
    { t: 11, text: 'S hour +1s A m24 ok f9' },
    { t: 12, text: 'S hour +1s B m1 ok f29' },
    { t: 13, text: 'S hour +1s C m24 ok f49' },
    { t: 14, text: 'Z C 2001ms' },
    { t: 15, text: 'S hour +1s D m24 E:x f69' },
    { t: 16, text: 'S hour +2s C m24 ok f89' },       // Z нет — службу прибили
    { t: 17, text: 'P open -' }
  ]
  const sh = dlog.sheet(e)
  assert.equal(sh.since, 10)
  assert.deepEqual(sh.items.map((x) => x.n + x.letter + x.mark), ['1A', '2B', '3C', '4D!', '5C?'])
  assert.deepEqual(dlog.sheetRows(sh.items, 3), ['1A   2B   3C', '4D!   5C?'])
  assert.equal(dlog.kindOf('Z C 2001ms'), 'svc')
  assert.deepEqual(dlog.summary(e), { s: 6, e: 1, p: 1 })   // строки Z в счёт срабатываний не входят
  // старый формат без буквы тоже разбирается
  assert.equal(dlog.sheet([{ t: 1, text: 'S hour +1s ok' }]).items[0].letter, '-')
  // меток нет — считаем всё
  assert.equal(dlog.sheet([{ t: 1, text: 'S hour +1s A m24 ok' }]).since, 0)
})

console.log('\nВсе проверки будильников и журнала пройдены: ' + n)
