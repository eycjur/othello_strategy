/* worker.js — 探索専用 Web Worker。局面を受け取り反復深化の途中経過を随時返す */
importScripts('engine.js');

self.onmessage = function (e) {
  var d = e.data;
  var board = new Uint8Array(d.board);
  var marks = new Uint8Array(d.marks);
  // ポイント式（R = 返した枚数, C = コンボ数, D = 確定コンボ）は
  // 黒・白それぞれ文字列で受け取りコンパイルする（UI 側と同じコンパイラを使う）
  var gainFnBlack = Engine.compileFormula(d.formulaBlack);
  var gainFnWhite = Engine.compileFormula(d.formulaWhite);
  Engine.solve(board, marks, d.player, d.maxPlies, d.passed, d.hpMe, d.hpOpp,
    gainFnBlack, gainFnWhite, function (p) {
      self.postMessage({ type: 'progress', token: d.token, result: p });
    }, d.rootMove);
  self.postMessage({ type: 'done', token: d.token });
};
