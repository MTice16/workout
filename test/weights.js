// Simulates weight saving and suggestions for the workout tracker.
// Run from the repo root: node test/weights.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const htmlPath = path.join(__dirname, "..", "index.html");
let html = fs.readFileSync(htmlPath, "utf8");
if(!html.includes("const IMGDATA = ")) throw new Error("IMGDATA missing — index.html shape changed");
html = html.replace(/^const IMGDATA = .*$/m, "const IMGDATA = {};");
const start = html.indexOf("<script>\nconst IMGDATA");
const end = html.indexOf("</script>", start);
if(start < 0 || end < 0) throw new Error("could not find the app script");
let code = html.slice(start + "<script>\n".length, end);
const cut = code.indexOf("/* ---------- init ---------- */");
if(cut < 0) throw new Error("init marker missing");
code = code.slice(0, cut) + `
globalThis.DATA = DATA;
globalThis.STATE = STATE;
globalThis.suggestFor = suggestFor;
globalThis.expectedReps = expectedReps;
globalThis.pickWeight = pickWeight;
globalThis.weightList = weightList;
globalThis.learnedList = learnedList;
globalThis.metaFor = metaFor;
globalThis.exKey = exKey;
globalThis.targetOf = targetOf;
globalThis.logsFor = logsFor;
globalThis.failCell = failCell;
globalThis.write = write;
globalThis.flushOutbox = flushOutbox;
globalThis.loadPersisted = loadPersisted;
globalThis.upsertPersonLog = upsertPersonLog;
globalThis.formatLogLine = formatLogLine;
globalThis.draftFor = draftFor;
globalThis.overlayOutbox = overlayOutbox;
globalThis.getOutbox = function(){ return OUTBOX; };
globalThis.groupsForDay = groupsForDay;
globalThis.DEFAULT_SS = DEFAULT_SS;
globalThis.SS_PLAN = SS_PLAN;
globalThis.ensurePlanSupersets = ensurePlanSupersets;
globalThis.setDB = function(d){ db = d; };
globalThis.setConnected = function(v){ CONNECTED = v; };
globalThis._clearFlushTimer = function(){ if(flushDelay){ clearTimeout(flushDelay); flushDelay = null; } };
globalThis._resetOutbox = function(){
  OUTBOX = [];
  saveJSON(OUTBOX_KEY, OUTBOX);
  flushing = false;
  if(flushDelay){ clearTimeout(flushDelay); flushDelay = null; }
};
`;

const store = {};
global.document = {
  addEventListener(){},
  removeEventListener(){},
  getElementById(){ return {textContent:"", className:"", hidden:true, innerHTML:"", classList:{add(){}, remove(){}, toggle(){}}}; },
  querySelectorAll(){ return []; },
  activeElement: null,
  body: { appendChild(){} }
};
global.localStorage = {
  getItem(k){ return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v){ store[k] = String(v); },
  removeItem(k){ delete store[k]; }
};

vm.runInThisContext(code, {filename: "index.html"});

const {
  DATA, STATE, suggestFor, expectedReps, pickWeight, weightList, learnedList, metaFor,
  exKey, targetOf, logsFor, failCell, write, flushOutbox, loadPersisted, upsertPersonLog,
  draftFor, overlayOutbox, getOutbox, setDB, setConnected, _clearFlushTimer, _resetOutbox
} = globalThis;

let failed = 0;
function assert(cond, msg){
  if(cond) return;
  failed++;
  console.error("FAIL: " + msg);
}
function exBy(week, day, name){
  const ex = DATA[week][day].ex.find(e => e.name === name);
  if(!ex) throw new Error("missing " + name);
  return ex;
}
function reset(){
  STATE.logs = {};
  STATE.exmeta = {};
  STATE.settings = {failure: true};
  STATE.order = {};
  STATE.reps = {};
  STATE.ss2 = {};
  STATE.done2 = {};
  _resetOutbox();
  setConnected(false);
  setDB(null);
  _clearFlushTimer();
}
function addLog(ex, person, weight, reps, tgt, ts, exp){
  const key = exKey(ex.name);
  const e = {person, weight: String(weight), ts};
  if(reps != null) e.reps = reps;
  if(tgt != null) e.tgt = tgt;
  if(exp != null) e.exp = exp;
  const id = "t" + ts + person[0];
  (STATE.logs[key] = STATE.logs[key] || {})[id] = e;
  return e;
}
// Same fields the app stores when a set is saved, including the expected-reps number.
function recordSet(ex, person, weight, reps, tgt, ts){
  const exp = expectedReps(ex, person, weight, tgt);
  addLog(ex, person, weight, reps, tgt, ts, exp);
  return exp;
}

function classListFor(el){
  const set = new Set((el.className || "").split(/\s+/).filter(Boolean));
  return {
    add(...cs){ cs.forEach(c => set.add(c)); el.className = [...set].join(" "); },
    remove(...cs){ cs.forEach(c => set.delete(c)); el.className = [...set].join(" "); },
    contains(c){ return set.has(c); }
  };
}
function makeEl(tag, attrs){
  attrs = attrs || {};
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    className: attrs.class || "",
    id: attrs.id || "",
    value: attrs.value || "",
    textContent: "",
    dataset: {},
    style: {}
  };
  if(attrs["data-person"]) el.dataset.person = attrs["data-person"];
  el.classList = classListFor(el);
  el.querySelector = sel => query(el, sel);
  return el;
}
function match(el, sel){
  if(sel.charAt(0) === ".") return el.className.split(/\s+/).includes(sel.slice(1));
  if(el.tagName === "INPUT" && sel.indexOf("input") === 0){
    const cls = sel.match(/\.([\w-]+)/);
    if(cls && !el.className.split(/\s+/).includes(cls[1])) return false;
    if(sel.indexOf("[data-person]") >= 0 && !el.dataset.person) return false;
    return true;
  }
  return false;
}
function query(el, sel){
  for(const c of el.children){
    if(match(c, sel)) return c;
    const found = query(c, sel);
    if(found) return found;
  }
  return null;
}
const VOID = {input:1, br:1, img:1};
function setHTML(el, html){
  el.children = [];
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>/g;
  let m, stack = [el], last = 0;
  while((m = re.exec(html))){
    last = re.lastIndex;
    if(m[1] === "/"){ if(stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const ar = /([\w:-]+)(?:="([^"]*)")?/g;
    let am;
    while((am = ar.exec(m[3]))) attrs[am[1]] = am[2] == null ? "" : am[2];
    const child = makeEl(m[2], attrs);
    stack[stack.length - 1].children.push(child);
    if(!VOID[m[2].toLowerCase()]) stack.push(child);
  }
}
function makeCell(){
  const el = makeEl("div");
  Object.defineProperty(el, "innerHTML", {
    set(v){ el._html = v; setHTML(el, v); },
    get(){ return el._html || ""; }
  });
  return el;
}
function drain(){
  return new Promise(resolve => setImmediate(resolve));
}

(async function main(){
  // --- suggestions: last logged weight is used as-is (not divided by 0.85) ---
  reset();
  const leg = exBy(1, 3, "Leg Press");
  const ext = exBy(1, 3, "Leg Extension");
  const fly = exBy(1, 1, "Dumbbell Fly Flat");
  const hammer = exBy(1, 2, "Hammer Curl (Dumbbell)");
  const bench = exBy(1, 1, "Barbell Bench Press");
  const planCases = [
    [bench, "matthias", 6, 175],
    [leg, "matthias", 10, 350],
    [ext, "matthias", 13, 145],
    [fly, "matthias", 11, 25],
    [hammer, "matthias", 11, 30]
  ];
  assert(suggestFor(bench, "hailey", 6) == null, "hailey should not get a prefilled bench weight");
  planCases.forEach(([ex, p, T, want])=>{
    const s = suggestFor(ex, p, T);
    assert(s && s.w === want, ex.name + " " + p + " plan start " + (s && s.w) + " wanted " + want + " (not " + (want / 0.85) + ")");
  });

  reset();
  const row = exBy(1, 2, "Barbell Bent Over Row");
  addLog(row, "matthias", 95, null, null, 1);
  const kept = suggestFor(row, "matthias", 6);
  assert(kept && kept.w === 95, "weight-only 95 should stay 95, got " + (kept && kept.w));
  assert(Math.abs(kept.w - 95 / 0.85) > 5, "95 was still inflated");

  // a logged weight that isn't on the 10 lb bar list is still the suggestion
  reset();
  const ez = exBy(2, 2, "EZ Bar Curl");
  addLog(ez, "nehemiah", 115, null, null, 1);
  const ezSug = suggestFor(ez, "nehemiah", 8);
  assert(ezSug && ezSug.w === 115, "logged 115 must not be rounded away, got " + (ezSug && ezSug.w));

  // --- same rep target stays put; a different week does not walk the weight down ---
  reset();
  const row1 = exBy(1, 4, "Seated Dumbbell Shoulder Press");
  const row2 = exBy(2, 1, "Seated Dumbbell Shoulder Press");
  recordSet(row1, "matthias", 30, 6, 6, 1);
  const seq = {6: [], 8: []};
  let ts = 2;
  for(let i = 0; i < 6; i++){
    const T = (i % 2 === 0) ? 8 : 6;
    const ex = T === 8 ? row2 : row1;
    const s = suggestFor(ex, "matthias", T);
    seq[T].push(s && s.w);
    recordSet(ex, "matthias", s.w, T, T, ts++);
  }
  console.log("seated press, hit every target:", JSON.stringify(seq));
  assert(seq[6].every(w => w === 30), "week-1 target drifted off 30: " + seq[6].join(" -> "));
  assert(seq[8].length >= 2 && seq[8].every(w => w === seq[8][0]), "week-2 target drifted: " + seq[8].join(" -> "));
  assert(expectedReps(row2, "matthias", seq[8][0], 8) != null, "same-target expectation should exist after a set is logged");

  reset();
  STATE.settings = {bw: {matthias: "180"}};
  const dip1 = exBy(1, 3, "Hanging Leg Raise");
  const dip2 = exBy(2, 3, "Hanging Leg Raise");
  recordSet(dip1, "matthias", 45, 7, 7, 1);
  const dips = {7: [], 8: []};
  ts = 2;
  for(let i = 0; i < 6; i++){
    const T = (i % 2 === 0) ? 8 : 7;
    const ex = T === 8 ? dip2 : dip1;
    const s = suggestFor(ex, "matthias", T);
    dips[T].push(s && s.w);
    recordSet(ex, "matthias", s.w, T, T, ts++);
  }
  console.log("hanging leg raise @180bw, hit every target:", JSON.stringify(dips));
  assert(dips[7].every(w => w === 45), "dips week-1 drifted off 45: " + dips[7].join(" -> "));
  assert(dips[8].every(w => w === dips[8][0]), "dips week-2 drifted: " + dips[8].join(" -> "));

  // --- someone else's machine weights don't pull this person ---
  reset();
  const rope = exBy(1, 4, "Rope Pushdowns");
  addLog(rope, "hailey", 112, 12, 12, 1);
  addLog(rope, "matthias", 100, 16, 12, 2);
  const ropeSug = suggestFor(rope, "matthias", 12);
  console.log("rope pushdowns matthias (hailey logged 112):", ropeSug && ropeSug.w);
  assert(ropeSug && ropeSug.w !== 112, "used Hailey's 112, got " + (ropeSug && ropeSug.w));
  assert(!learnedList(exKey(rope.name), "matthias").includes(112), "learned list includes the other person");
  assert(learnedList(exKey(rope.name), "hailey").includes(112), "Hailey's own list should keep 112");

  // --- gym increments ---
  const dbs = weightList(exKey("Dumbbell Fly Flat"));
  assert(dbs[0] === 2.5 && dbs.includes(30) && dbs.includes(35) && dbs[dbs.length - 1] === 210, "dumbbell list " + dbs[0] + ".." + dbs[dbs.length - 1]);
  assert(!dbs.includes(32.5) && !dbs.includes(215) && !dbs.includes(250), "dumbbell list has a weight this gym doesn't");
  assert(pickWeight(exKey("Dumbbell Fly Flat"), 33).w === 35, "33 lb dumbbell rounded to " + pickWeight(exKey("Dumbbell Fly Flat"), 33).w);
  assert(pickWeight(exKey("Dumbbell Fly Flat"), 208).w === 210, "208 lb dumbbell rounded to " + pickWeight(exKey("Dumbbell Fly Flat"), 208).w);
  assert(pickWeight(exKey("Dumbbell Fly Flat"), 250).w === 210, "over-max dumbbell rounded to " + pickWeight(exKey("Dumbbell Fly Flat"), 250).w);
  const fixed = weightList(exKey("EZ Bar Curl"));
  assert(fixed[0] === 10 && fixed[fixed.length - 1] === 200 && fixed[1] - fixed[0] === 10, "fixed bar list " + fixed[0] + ".." + fixed[fixed.length - 1]);
  assert(pickWeight(exKey("EZ Bar Curl"), 33).w === 30, "33 lb fixed bar rounded to " + pickWeight(exKey("EZ Bar Curl"), 33).w);
  assert(pickWeight(exKey("EZ Bar Curl"), 36).w === 40, "36 lb fixed bar rounded to " + pickWeight(exKey("EZ Bar Curl"), 36).w);
  const olympic = weightList(exKey("Barbell Bench Press"));
  assert(olympic.includes(45) && olympic.includes(135) && !olympic.includes(10), "bench press should stay a 45 lb bar with plates");
  // a saved plate-bar setting from the old defaults must not keep a fixed bar on plate math
  STATE.exmeta = { "barbell-curl": {bar: 45, equip: "bar", rule: "fail", sides: 2} };
  const curlList = weightList(exKey("Barbell Curl"));
  assert(metaFor(exKey("Barbell Curl")).equip === "fixed", "barbell curl equip " + metaFor(exKey("Barbell Curl")).equip);
  assert(curlList[0] === 10 && curlList[curlList.length - 1] === 200, "barbell curl still using plate increments");
  STATE.exmeta = {};

  // --- typing a weight saves it before reps, survives a redraw, and is not replaced ---
  reset();
  addLog(row1, "matthias", 50, 6, 6, Date.now() - 10 * 86400000);
  const cell = makeCell();
  failCell(row1, "matthias", targetOf("4x6"), "4x6", cell);
  const lastLine = cell.querySelector(".wlast").textContent;
  assert(lastLine.indexOf("50 × 6") === 0, "last log line: " + JSON.stringify(lastLine));
  const wI = cell.querySelector(".fw");
  const rI = cell.querySelector(".fr");
  assert(wI.value === "", "box should start empty (history is the line under it), got " + JSON.stringify(wI.value));
  wI.value = "95";
  wI.oninput();
  assert(draftFor(exKey(row1.name), "matthias").w === "95", "draft did not keep the typed weight");
  const mid = logsFor(exKey(row1.name)).filter(e => e.person === "matthias" && String(e.weight) === "95");
  assert(mid.length === 1 && !(+mid[0].reps > 0), "weight was not saved before reps");
  const cache = JSON.parse(localStorage.getItem("wt2_cache"));
  assert(cache.logs[exKey(row1.name)][mid[0].id].weight === "95", "weight was not in the phone cache");
  const cell2 = makeCell();
  failCell(row1, "matthias", targetOf("4x6"), "4x6", cell2);
  const w2 = cell2.querySelector(".fw");
  const r2 = cell2.querySelector(".fr");
  assert(w2.value === "95", "redraw cleared the typed weight, box is " + JSON.stringify(w2.value));
  r2.value = "6";
  r2.oninput();
  const done = logsFor(exKey(row1.name)).filter(e => e.person === "matthias" && isFinite(e.ts) && e.ts > Date.now() - 86400000);
  assert(done.length === 1 && done[0].weight === "95" && done[0].reps === 6, "saved " + JSON.stringify(done[done.length - 1]) + " (suggestion was 50)");

  // reps with an empty weight must not store the suggestion
  reset();
  const cell3 = makeCell();
  failCell(leg, "matthias", targetOf("4x8"), "4x8", cell3);
  const rw = cell3.querySelector(".fw"), rr = cell3.querySelector(".fr");
  rr.value = "8";
  rr.oninput();
  rr.onchange();
  const legLogs = logsFor(exKey(leg.name));
  assert(legLogs.length === 0, "empty weight saved a log: " + JSON.stringify(legLogs));
  assert(rw.classList.contains("need"), "empty weight was not marked");

  // editing today's weight updates the same entry instead of adding another
  reset();
  const a = upsertPersonLog("back-squat", "matthias", {weight: "225"});
  const b = upsertPersonLog("back-squat", "matthias", {weight: "245"});
  assert(a.id === b.id && logsFor("back-squat").length === 1 && logsFor("back-squat")[0].weight === "245", "same-day edit created a second log");

  // --- offline: phone keeps the set, reload keeps it, upload happens once ---
  reset();
  const ts0 = Date.now();
  write("logs/leg-press/offline1", {person: "matthias", weight: "350", reps: 8, tgt: 8, ts: ts0});
  write("logs/leg-press/offline1", {person: "matthias", weight: "360", reps: 8, tgt: 8, ts: ts0});
  assert(getOutbox().length === 1 && getOutbox()[0].value.weight === "360", "outbox kept both edits: " + JSON.stringify(getOutbox()));
  STATE.logs = {};
  loadPersisted();
  assert(logsFor("leg-press").some(e => e.id === "offline1" && e.weight === "360"), "reload lost the offline set");
  assert(getOutbox().length === 1, "reload lost the outbox");
  STATE.logs = {};
  overlayOutbox("logs");
  assert(STATE.logs["leg-press"].offline1.weight === "360", "server snapshot erased the unsent set");

  const sent = [];
  setDB({
    ref(p){
      return {
        set(v){ sent.push({path: p, value: v}); return Promise.resolve(); },
        push(){ return {key: "generated"}; }
      };
    }
  });
  setConnected(true);
  flushOutbox();
  await drain();
  assert(sent.length === 1 && sent[0].path === "logs/leg-press/offline1" && sent[0].value.weight === "360", "upload " + JSON.stringify(sent));
  assert(getOutbox().length === 0, "outbox still holding a sent set");
  flushOutbox();
  await drain();
  assert(sent.length === 1, "second flush duplicated the upload");

  // a failed upload stays queued and the retry does not create a second set
  _resetOutbox();
  let failSend = true;
  const attempts = [];
  setDB({
    ref(p){
      return {
        set(v){
          attempts.push({path: p, value: v});
          return failSend ? Promise.reject(new Error("offline")) : Promise.resolve();
        },
        push(){ return {key: "generated"}; }
      };
    }
  });
  setConnected(true);
  write("logs/leg-press/retry1", {person: "nehemiah", weight: "270", ts: Date.now()});
  flushOutbox();
  await drain();
  assert(getOutbox().length === 1, "failed upload was dropped");
  failSend = false;
  flushOutbox();
  await drain();
  assert(getOutbox().length === 0 && attempts.length === 2, "retry result " + attempts.length + " outbox " + getOutbox().length);
  assert(attempts[0].path === attempts[1].path && attempts[1].value.weight === "270", "retry changed the set");
  _clearFlushTimer();

  // --- new plan: groups, rest, failure markers, images, hailey left blank ---
  reset();
  const heavyStop = ["Barbell Bench Press","Dumbbell Bench Press","Standing Barbell Overhead Press","Seated Dumbbell Shoulder Press","Barbell Incline Press","Incline Dumbbell Press","Back Squat","Front Squat","Hack Squat","Deadlift","Trap Bar Deadlift","Leg Press","Hip Thrust Machine","Bulgarian Split Squat","Machine Shoulder Press"];
  const mediumLast = ["Pull Ups","Weighted Chin Ups","Barbell Bent Over Row","Hammer Strength Row","Single Arm Dumbbell Row","Chest Supported Row Machine","Seated Cable Row (neutral grip)","Seated Cable Row (close grip)","Lat Pulldown (wide grip)","Neutral Grip Pulldown","Weighted Dips","JM Press"];
  const seen = {};
  [1, 2].forEach(w => [1, 2, 3, 4, 5].forEach(d => {
    const names = DATA[w][d].ex.map(e => e.name);
    assert(new Set(names).size === names.length, "duplicate on week " + w + " day " + d);
    DATA[w][d].ex.forEach(e => {
      seen[e.name] = true;
      assert(e.img, "missing image " + e.name);
      assert(e.effort === "stop" || e.effort === "last", "effort " + e.name);
      assert(!e.note || !/\bH\b/.test(e.note), "hailey prefilled on " + e.name + " " + e.note);
      const solo = DATA[w][d].ex.filter(x => x.letter === e.letter).length === 1;
      if(solo) assert(e.rest, e.name + " solo has no rest");
    });
  }));
  heavyStop.forEach(n => {
    assert(seen[n], "missing heavy " + n);
    [1, 2].forEach(w => [1, 2, 3, 4, 5].forEach(d => DATA[w][d].ex.forEach(e => {
      if(e.name === n) assert(e.effort === "stop" && e.backoff, n + " should stop short with a back-off");
    })));
  });
  mediumLast.forEach(n => {
    [1, 2].forEach(w => [1, 2, 3, 4, 5].forEach(d => DATA[w][d].ex.forEach(e => {
      if(e.name === n) assert(e.effort === "last" && e.backoff, n + " should be last set to failure");
    })));
  });
  ["Barbell Curl","Dumbbell Lateral Raise","Cable Face Pull","EZ Bar Skull Crushers","Leg Extension","Leg Curl","Standing Calf Raise","Dumbbell Shrugs","Rope Pushdowns"].forEach(n => {
    [1, 2].forEach(w => [1, 2, 3, 4, 5].forEach(d => DATA[w][d].ex.forEach(e => {
      if(e.name === n) assert(e.effort === "last" && !e.backoff, n + " isolation got a back-off or the wrong marker");
    })));
  });
  STATE.ss2 = {tue: {old: {keys: ["pull-ups","hammer-curl-dumbbell-"], sets: "3", t: Date.now()}}};
  STATE.settings = {};
  const tue = groupsForDay(1, 2);
  assert(tue.some(g => g.keys.includes("pull-ups") && g.keys.includes("reverse-cable-fly")), "old Tuesday group hid the new pull-up pair " + JSON.stringify(tue));
  assert(!tue.some(g => g.keys.includes("pull-ups") && g.keys.includes("hammer-curl-dumbbell-")), "stale Tuesday group still showing");
  const mon = groupsForDay(1, 1);
  assert(mon.some(g => g.rest && g.keys.includes("barbell-bench-press") && g.keys.includes("cable-face-pull")), "Monday bench pair " + JSON.stringify(mon));
  assert(groupsForDay(1, 1).every(g => !g.keys.includes("standing-barbell-overhead-press")), "overhead press should stay solo");
  const fri1 = groupsForDay(1, 5);
  const fri2 = groupsForDay(2, 5);
  assert(fri1.some(g => g.keys.includes("hip-thrust-machine") && g.keys.includes("bulgarian-split-squat")), "week 1 hip thrust pair");
  assert(fri2.some(g => g.keys.includes("hip-thrust-machine") && g.keys.includes("farmer-carry")), "week 2 hip thrust pair");
  assert(!fri1.some(g => g.keys.includes("farmer-carry") && g.keys.includes("hip-thrust-machine")), "week 1 picked the week 2 hip thrust pair");
  assert(exBy(1, 5, "Deadlift").rest && exBy(2, 5, "Trap Bar Deadlift").effort === "stop", "deadlift rest / trap bar marker");
  reset();
  STATE.ss2 = {mon: {oldbench: {keys: ["barbell-bench-press","incline-dumbbell-press"], sets: "4", t: 9}}};
  ensurePlanSupersets();
  assert(STATE.settings.ssPlan === SS_PLAN, "plan version was not saved");
  assert(STATE.ss2.mon["plan-mon-w1-a"] && STATE.ss2.mon["plan-mon-w1-a"].keys.includes("cable-face-pull"), "plan group was not seeded");
  assert(!STATE.ss2.mon.oldbench, "overlapping old Monday group was kept");
  assert(STATE.logs && Object.keys(STATE.logs).length === 0, "superset reset touched logs");

  if(failed){
    console.error(failed + " failed");
    process.exit(1);
  }
  console.log("all weight tests passed");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
