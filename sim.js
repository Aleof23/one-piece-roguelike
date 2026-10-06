/* Simulador de balance: carga la logica REAL de index.html (primer <script>) y juega runs con bots.
   Uso: node sim.js [dir] [runsPorNivel]  */
const fs = require('fs');
const dir = process.argv[2] || '.';
const RUNS = +(process.argv[3] || 2000);
const html = fs.readFileSync(dir + '/index.html', 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const G = new Function(code + `
return { buildData, installData, newGame, mods, crewPower, enemyPower, availableIds, gainItem, eat, advance, projectRisk, fight, sleep, makeMember,
  recruitCandidates, availableFruits, harmony, itemPool, slotFull, stepRound, smartOrders, autoOrders, itemPrice, rationPrice, equipItem, swapItem, canSwap, removeItem, autoBattle, battleInit, get ARCHETYPES(){return ARCHETYPES}, get AVATARS(){return AVATARS}, canRecruit, leadRoom, usedLead, shuffle, weightedPick,
  get STAGES(){return STAGES}, get ITEMS(){return ITEMS}, get SETTINGS(){return SETTINGS}, get NAKAMAS(){return NAKAMAS} };`)();

const raw = {};
for (const k of ['characters', 'fruits', 'stages', 'items']) raw[k] = JSON.parse(fs.readFileSync(dir + '/' + k + '.json', 'utf8'));
const res = G.buildData(raw);
if (res.errors.length) { console.log(res.errors); process.exit(1); }
G.installData(res.data);
if (process.env.SET) Object.assign(G.SETTINGS, JSON.parse(process.env.SET));
if (process.env.IS) { const k = +process.env.IS; const sc = o => { for (const key in o) if (typeof o[key] === 'number' && !['lead','ward','revive','reveal','aggro','pierce'].includes(key)) o[key] = o[key] * k; else if (o[key] && typeof o[key] === 'object') sc(o[key]); }; G.ITEMS.forEach(it => { sc(it.fx); if (it.equip) { const e = it.equip; ['atkPct','crit','acc','dodge','guardPct','charge','hpPct'].forEach(q => { if (e[q]) e[q] *= k; }); if (e.stats) for (const q in e.stats) e.stats[q] = Math.max(1, Math.round(e.stats[q] * k)); } }); }
if (process.env.BOSS) { const m = JSON.parse(process.env.BOSS); G.STAGES.forEach((st, i) => { st.boss.powerMult = m[i] / st.powerMult; }); }

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const pool = g => g.crew.filter(c => c.hp > 0).reduce((s, c) => s + c.hp, 0);
const maxPool = g => g.crew.reduce((s, c) => s + c.maxHp, 0);
const Q = (crew, m) => crew.reduce((s, c) => s + c.atk, 0) * (1 + m.power) * crew.reduce((s, c) => s + c.maxHp, 0) * (1 + G.harmony(crew).score / 100);

/* riesgo: 1 - probabilidad de ganar (Monte Carlo con la IA automatica) */
function riskOf(g, node, N = 10){
  const r = G.projectRisk(g, node, N); return 1 - r[2] / 100;
}
const crewQ = g => { const h = G.harmony(g.crew).score; return g.crew.reduce((x, c) => x + c.atk * c.maxHp, 0) * (1 + h / 100); };

/* ---------------- perfiles de jugador ---------------- */
const PROFILES = {
  novice:  { name:'Novato (aleatorio)',  path:'random', buy:'random', recruit:'random', fruit:'random', ration:0 },
  casual:  { name:'Casual',              path:'greedy1', buy:'ok',     recruit:'ok',     fruit:'atk',    ration:.5 },
  veteran: { name:'Veterano',            orders:'smart', path:'look',    buy:'good',   recruit:'good',   fruit:'best',   ration:.9 },
  expert:  { name:'Experto (optimo)',    orders:'smart', path:'dfs',     buy:'best',   recruit:'best',   fruit:'best',   ration:1 },
};

function itemScore(g, it){
  const f = it.fx || {}, n = g.crew.length;
  const ph = g.crew.reduce((s,c)=>s+c.maxHp,0);
  let v = 0;
  v += (f.power||0) + (f.guard||0)*1.3 + ((f.hp||0) * n) / Math.max(1, ph) * 0.9 + (f.lead||0)*0.10 + (f.berry||0)*0.12 + (f.camp||0)*0.10;
  v += (f.spd||0)*0.03 + (f.crit||0)*1.2 + (f.acc||0)*0.8 + (f.dodge||0) + (f.charge||0)*0.012 + (f.regen||0)*4 + (f.harm||0)*0.01
     + (f.reveal||0)*0.04 + (f.calm||0)*0.15 + (f.ambush||0) + (f.loot||0)*0.3 + (f.ward||0)*0.05 + (f.revive||0)*0.12;
  const e = it.equip;
  if (e) {
    let w = (e.atkPct||0) + Object.values(e.stats||{}).reduce((a,b)=>a+b,0)*0.03 + (e.crit||0)*1.2 + (e.acc||0)*0.8 + (e.dodge||0) + (e.charge||0)*0.01
      + (e.guardPct||0) + (e.hpPct||0)*0.5 + Object.values(e.haki||{}).reduce((a,b)=>a+b,0)*0.12 + (e.pierce?0.08:0) + ((e.aggro||1)>1?0.05:0);
    v += w * Math.min(1, 1.6 / Math.max(1, n));
  }
  return v;
}

function chooseNode(g, P, rnd){
  const av = G.availableIds(g).map(id => g.map.byId[id]);
  if (av.length === 1 || P.path === 'random') return av[Math.floor(rnd() * av.length)];
  const hurt = 1 - pool(g) / maxPool(g);
  const base = (n, depthWeight) => {
    switch (n.type) {
      case 'camp': return 0.25 + hurt * 2.2;
      case 'recruit': return G.recruitCandidates(g).length && g.crew.length < G.SETTINGS.crewSlots && G.leadRoom(g) >= 1 ? 1.1 : 0;
      case 'market': return g.berries >= 100 ? 0.5 + Math.min(1, g.berries / 400) : 0.1;
      case 'chest': return G.availableFruits(g).length && g.crew.some(c => !c.fruit) ? 1.6 : 0.2;
      case 'boss': return 0;
      default: { const r = riskOf(g, n); const gain = 0.35; return r >= 0.95 ? -50 : gain - r * 2.2; }
    }
  };
  if (P.path === 'greedy1') {
    return av.map(n => ({ n, s: base(n) + rnd() * 0.9 })).sort((a, b) => b.s - a.s)[0].n;
  }
  // look / dfs: suma sobre la mejor ruta hasta el jefe, con el estado actual como aproximacion
  const memo = new Map();
  const best = n => {
    if (memo.has(n.id)) return memo.get(n.id);
    let s = base(n);
    if (n.next.length) s += Math.max(...n.next.map(id => best(g.map.byId[id]))) * (P.path === 'dfs' ? 1 : 0.55);
    memo.set(n.id, s); return s;
  };
  const noise = P.path === 'dfs' ? 0 : 0.5;
  return av.map(n => ({ n, s: best(n) + rnd() * noise })).sort((a, b) => b.s - a.s)[0].n;
}

function doMarket(g, P, rnd){
  const offers = G.shuffle(G.itemPool(g), rnd).slice(0, 3);
  let list = offers.slice();
  if (P.buy === 'random') list = G.shuffle(list, rnd);
  else if (P.buy === 'ok') list = list.sort((a, b) => (b.fx.power || 0) + (b.fx.guard || 0) - (a.fx.power || 0) - (a.fx.guard || 0));
  else list = list.sort((a, b) => itemScore(g, b) / G.itemPrice(g, b) - itemScore(g, a) / G.itemPrice(g, a));
  for (const o of list) {
    if (g.berries < G.itemPrice(g, o) || G.slotFull(g, o)) continue;
    if (P.buy === 'best' && itemScore(g, o) < 0.06) continue;
    g = G.gainItem({ ...g, berries: g.berries - G.itemPrice(g, o) }, o);
  }
  // raciones
  const frac = pool(g) / maxPool(g);
  if (rnd() < P.ration) {
    let guard = 0;
    while (g.berries >= G.rationPrice(g) && pool(g) / maxPool(g) < 0.8 && guard++ < 3 && !(P.buy === 'best' && g.berries < G.rationPrice(g))) {
      g = { ...g, berries: g.berries - G.rationPrice(g), crew: g.crew.map(c => c.hp > 0 ? { ...c, hp: Math.min(c.maxHp, c.hp + Math.round(c.maxHp * .35)) } : c) };
    }
  }
  return g;
}

function doRecruit(g, P, rnd){
  let cands = G.weightedPick(G.recruitCandidates(g), 2);
  const lvl = g.stage + 1;
  const mk = d => G.makeMember(d, lvl, 'c' + g.uid);
  const order = P.recruit === 'random' ? G.shuffle(cands, rnd) : cands.slice();
  const val = d => { const c = mk(d); const crew2 = [...g.crew, c]; return Q(crew2, G.mods(g)); };
  if (P.recruit !== 'random') order.sort((a, b) => val(b) / (Q(g.crew, G.mods(g))) - val(a) / Q(g.crew, G.mods(g)));
  for (const d of order) {
    if (!G.canRecruit(d, g)) continue;
    if (P.recruit === 'random' && rnd() < .25) continue;
    if (P.recruit === 'ok' && d.baseAtk * d.baseHp < 700) continue;
    if (P.recruit === 'best') {
      // no gastes liderazgo en reclutas flojos: exige mejorar Q al menos 12% por cada recluta
      if (val(d) / Q(g.crew, G.mods(g)) < 1.04 && g.crew.length > 1) continue;
    }
    g = { ...g, crew: [...g.crew, mk(d)], uid: g.uid + 1 };
  }
  return g;
}

function doChest(g, P, rnd){
  const pool_ = G.availableFruits(g);
  if (!pool_.length) return { ...g, berries: g.berries + 150 };
  const fruit = G.weightedPick(pool_, 1)[0];
  const elig = g.crew.filter(c => !c.fruit);
  if (!elig.length) return { ...g, berries: g.berries + 150 };
  let target;
  if (P.fruit === 'random') target = elig[Math.floor(rnd() * elig.length)];
  else if (P.fruit === 'atk') target = elig.slice().sort((a, b) => b.atk - a.atk)[0];
  else target = elig.slice().sort((a, b) => Q(G.eat(g, b.id, fruit).crew, G.mods(g)) - Q(G.eat(g, a.id, fruit).crew, G.mods(g)))[0];
  return G.eat(g, target.id, fruit);
}

function takeDrop(g, it, P){
  if (P.buy === 'random' && Math.random() < .3) return g;
  if (!G.slotFull(g, it)) return G.gainItem(g, it);
  const worst = g.items.filter(o => !!o.equip === !!it.equip).sort((a, b) => itemScore(g, a) - itemScore(g, b))[0];
  if (P.buy !== 'random' && itemScore(g, it) > itemScore(g, worst) && G.canSwap(g, worst, it)) return G.swapItem(g, worst.id, it);
  return g;
}
function playRun(P, seed){
  const rnd = mulberry32(seed);
  const realRandom = Math.random; Math.random = rnd;
  try {
    let g = G.newGame('user', { archetypeId: G.ARCHETYPES[Math.floor(rnd() * G.ARCHETYPES.length)].id, avatarId: 'boy' });
    const log = { stage: 0, cause: '' };
    let steps = 0;
    while (!g.over && steps++ < 400) {
      const node = chooseNode(g, P, rnd);
      g = { ...g, pos: node.id, visited: [...g.visited, node.id] };
      if (node.type === 'marine' || node.type === 'pirate' || node.type === 'boss') {
        // el jugador no puede huir: se entra y se pelea
        if (node.type === 'boss') (globalThis.__br = globalThis.__br || []).push([g.stage, riskOf(g, node)]);
        if (node.type === 'boss') (globalThis.__bs = globalThis.__bs || {})[g.stage] = ((globalThis.__bs || {})[g.stage] || [0, 0]);
        let r;
        { const st = G.battleInit(g, node); let k = 0; while (!st.over && k++ < 40) G.stepRound(st, P.orders === 'smart' ? G.smartOrders(st) : G.autoOrders(st)); r = G.fight(g, node, st); }
        if (node.type === 'boss') { const e = globalThis.__bs[g.stage]; e[0]++; if (r.win) e[1]++; }
        if (node.type !== 'boss') { const f0 = r.rows.reduce((a, x) => a + x.from, 0), t0 = r.rows.reduce((a, x) => a + x.to, 0); const nl = (globalThis.__nl = globalThis.__nl || {}); (nl[g.stage] = nl[g.stage] || []).push(1 - t0 / Math.max(1, f0)); }
        g = r.g;
        if (r.win && r.item) g = takeDrop(g, r.item, P);
        if (!r.win) { g = { ...g, over: 'lose' }; log.cause = node.type + '@f' + node.f; break; }
        if (r.boss) { g = G.advance(g); const b=(globalThis.__bb=globalThis.__bb||{}); (b[g.stage]=b[g.stage]||[]).push(g.berries); (globalThis.__bc=globalThis.__bc||{}); (globalThis.__bc[g.stage]=globalThis.__bc[g.stage]||[]).push(g.crew.length); }
      } else if (node.type === 'market') g = doMarket(g, P, rnd);
      else if (node.type === 'recruit') g = doRecruit(g, P, rnd);
      else if (node.type === 'camp') g = G.sleep(g).g;
      else if (node.type === 'chest') g = doChest(g, P, rnd);
    }
    return { win: g.over === 'win', stage: g.stage, cause: log.cause, crew: g.crew.length, items: g.items.length, berries: g.berries };
  } finally { Math.random = realRandom; }
}

const only = process.argv[4];
console.log('Etapas:', G.STAGES.map(s => s.powerMult).join(' '), '| lvl x', G.SETTINGS.levelUpAtkMult, '/', G.SETTINGS.levelUpHpMult, '| lead', G.SETTINGS.leadership, '+', G.SETTINGS.leadershipPerStage);
for (const [k, P] of Object.entries(PROFILES)) {
  if (only && only !== k) continue;
  globalThis.__br = []; globalThis.__bs = {}; globalThis.__bb = {};
  let wins = 0; const reach = new Array(G.STAGES.length + 1).fill(0); const causes = {}; let crewSum = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = playRun(P, 1000 + i * 7919 + (+process.env.SEED || 0));
    if (r.win) wins++;
    reach[r.win ? G.STAGES.length : r.stage]++;
    crewSum += r.crew;
    if (!r.win) { const key = r.cause.split('@')[0]; causes[key] = (causes[key] || 0) + 1; }
  }
  if (process.env.BS) console.log('BS ' + JSON.stringify(Object.keys(globalThis.__bs).sort((a,b)=>a-b).map(k => globalThis.__bs[k][0] ? +(globalThis.__bs[k][1] / globalThis.__bs[k][0]).toFixed(3) : null)));
  if (process.env.BB) console.log('   berries al entrar al mar (media):', Object.keys(globalThis.__bb).map(k=>(+k+1)+':'+Math.round(globalThis.__bb[k].reduce((a,b)=>a+b,0)/globalThis.__bb[k].length)).join('  '));
  if (process.env.BB) console.log('   crew al entrar al mar:', Object.keys(globalThis.__bc||{}).map(k=>(+k+1)+':'+(globalThis.__bc[k].reduce((a,b)=>a+b,0)/globalThis.__bc[k].length).toFixed(1)).join('  ')); globalThis.__bc={};
  if (process.env.NL) { console.log('   pérdida media de vida por combate normal:', Object.keys(globalThis.__nl||{}).map(k=>(+k+1)+':'+Math.round(100*globalThis.__nl[k].reduce((a,b)=>a+b,0)/globalThis.__nl[k].length)+'%').join('  ')); } globalThis.__nl={};
  const dist = reach.map(x => (x / RUNS * 100).toFixed(0).padStart(3)).join(' ');
  if (process.env.BR) { const by = {}; globalThis.__br.forEach(([st, r]) => (by[st] = by[st] || []).push(r)); console.log('   riesgo al llegar al jefe (mediana / p90) por etapa:', Object.keys(by).map(st => { const a = by[st].sort((x, y) => x - y); return (+st + 1) + ':' + a[Math.floor(a.length * .5)].toFixed(2) + '/' + a[Math.floor(a.length * .9)].toFixed(2); }).join('  ')); }
  console.log(`${P.name.padEnd(22)} winrate ${(wins / RUNS * 100).toFixed(1).padStart(5)}%  | muere en etapa 1..10,WIN: ${dist} | crew medio ${(crewSum / RUNS).toFixed(1)} | causa ${JSON.stringify(causes)}`);
}
