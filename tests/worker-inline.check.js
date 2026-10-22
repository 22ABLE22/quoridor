// Node 验证 Worker 内联源码的引擎可用性（模拟 worker 命令回路）
const fs = require('fs'), vm = require('vm');
const rulesSrc = fs.readFileSync('js/rules.js', 'utf8');
const aiSrc = fs.readFileSync('js/ai.js', 'utf8');
const cmdLoop = `
self.onmessage = function (e) {
  var msg = e.data;
  try {
    if (msg.cmd === 'decide') {
      var action = QAI.decide(msg.state, msg.pi, msg.budgetMs);
      self.postMessage({ id: msg.id, ok: true, action: action });
    } else if (msg.cmd === 'winrate') {
      var rate = QAI.simulateWinRate(msg.state, msg.pi, msg.rollouts);
      self.postMessage({ id: msg.id, ok: true, rate: rate });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};`;
const snap = {
    mode: 2,
    players: [
        { id: 0, seatKey: 'N', name: 'Red', color: '#d64545', goal: 'N', type: 'ai', wallQuota: 10, walls: 10, pos: { x: 4, y: 8 } },
        { id: 1, seatKey: 'S', name: 'Blue', color: '#3f6fd8', goal: 'S', type: 'ai', wallQuota: 10, walls: 10, pos: { x: 4, y: 0 } }
    ],
    hw: Array.from({ length: 8 }, () => new Array(8).fill(0)),
    vw: Array.from({ length: 8 }, () => new Array(8).fill(0)),
    turn: 0, moveNo: 1, history: [], winner: null
};
const replies = [];
const self = { postMessage: (m) => replies.push(m) };
const ctx = vm.createContext({
    self,
    msg1: { id: 1, cmd: 'winrate', state: snap, pi: 0, rollouts: 20 },
    msg2: { id: 2, cmd: 'decide', state: snap, pi: 0, budgetMs: 300 },
    console, Math, Date, setTimeout: () => {}, clearTimeout: () => {}
});
vm.runInContext(rulesSrc, ctx, { filename: 'rules.js' });
vm.runInContext(aiSrc, ctx, { filename: 'ai.js' });
vm.runInContext(cmdLoop, ctx, { filename: 'worker-loop.js' });

vm.runInContext('self.onmessage({ data: msg1 })', ctx);
console.log('winrate reply:', JSON.stringify(replies[0]));

const t0 = Date.now();
vm.runInContext('self.onmessage({ data: msg2 })', ctx);
console.log('decide reply:', JSON.stringify(replies[1]), 'in', Date.now() - t0, 'ms');
