/* game.js — UI 制御。ゲーム状態の管理・描画・Web Worker への解析依頼
 *
 * 状態管理（docs/SPEC.md §5）: 信頼できる状態は「着手マスの列 cells」と
 * 画面上の設定（初期HP・ポイント式）だけ。盤面・マーク・手番・自動パス・
 * 各着手の (R, C, D)・ポイント・HP・終了状態は、cells のリプレイで毎回導出する。
 * これによりポイント式や初期HPを対局途中に変えても過去の手を含めて自動で
 * 再計算され、待った（undo = cells.pop()）とも常に整合する。
 */
(function () {
  'use strict';
  var E = Engine;
  var BLACK = E.BLACK, WHITE = E.WHITE, EMPTY = E.EMPTY;

  var boardEl = document.getElementById('board');
  var statusEl = document.getElementById('statusBar');
  var ptsBlackEl = document.getElementById('ptsBlack');
  var ptsWhiteEl = document.getElementById('ptsWhite');
  var scoreBlackEl = document.getElementById('scoreBlack');
  var scoreWhiteEl = document.getElementById('scoreWhite');
  var turnInfoEl = document.getElementById('turnInfo');
  var evalMainEl = document.getElementById('evalMain');
  var evalDetailEl = document.getElementById('evalDetail');
  var evalProgressEl = document.getElementById('evalProgress');
  var hpInputEls = [null, document.getElementById('hpBlack'), document.getElementById('hpWhite')];
  var presetSelectEls = [null, document.getElementById('presetBlack'), document.getElementById('presetWhite')];
  var formulaInputEls = [null, document.getElementById('formulaBlack'), document.getElementById('formulaWhite')];
  var formulaErrorEl = document.getElementById('formulaError');
  var btnNew = document.getElementById('btnNew');
  var btnRestart = document.getElementById('btnRestart');
  var btnUndo = document.getElementById('btnUndo');
  var btnBest = document.getElementById('btnBest');

  // 列ラベル a-f / 行ラベル 1-6
  var colLabels = document.getElementById('colLabels');
  var rowLabels = document.getElementById('rowLabels');
  for (var i = 0; i < 6; i++) {
    var cl = document.createElement('span');
    cl.textContent = String.fromCharCode(97 + i);
    colLabels.appendChild(cl);
    var rl = document.createElement('span');
    rl.textContent = String(i + 1);
    rowLabels.appendChild(rl);
  }

  function playerName(p) { return p === BLACK ? '黒' : '白'; }

  /* ---------------- ポイント式 ---------------- */

  var PRESETS = {
    attack: '1.4 * 1800 * 1.2 ** (R - 1) * 2 ** C',
    other: '1000 * 1.2 ** (R - 1) + 1800 * (C + 1) + 1800 * D + 700'
  };
  // ポイント式・式エラーは黒と白で別々に持つ（添字 = プレイヤー番号）
  var formulas = [null, PRESETS.attack, PRESETS.attack];
  var gainFns = [null, E.compileFormula(PRESETS.attack), E.compileFormula(PRESETS.attack)];
  var formulaErrors = [null, '', ''];
  formulaInputEls[BLACK].value = formulas[BLACK];
  formulaInputEls[WHITE].value = formulas[WHITE];

  function applyFormula(player, expr) {
    try {
      gainFns[player] = E.compileFormula(expr);
      formulas[player] = expr;
      formulaErrors[player] = '';
      showFormulaErrors();
      refresh();
    } catch (err) {
      // 不正な式は適用せず、直前の式を維持する（局面は変わらないので再計算不要）
      formulaErrors[player] = playerName(player) + 'の式エラー: ' + err.message;
      showFormulaErrors();
    }
  }

  function showFormulaErrors() {
    formulaErrorEl.textContent = formulaErrors.filter(Boolean).join(' ／ ');
  }

  function gainOf(player, R, C, D) {
    var v = Number(gainFns[player](R, C, D));
    return isFinite(v) ? v : 0;
  }

  /* ---------------- ゲーム状態（すべて cells から導出） ---------------- */

  var cells = [];         // 着手マスの列。自動パスは記録しない（リプレイで導出できる）
  var pos = null;         // rebuild() が導出した現在局面
  var worker = null;      // 解析用 Worker
  var analysisToken = 0;  // 古い解析結果を捨てるためのトークン
  var latestBest = null;  // {token, move} 最新解析の最善手
  var analysisNote = '';  // 解析カードに添える補足（初期局面の d5 固定など）

  function initialHP(player) {
    var v = parseInt(hpInputEls[player].value, 10);
    return v >= 1 ? v : 30000;
  }

  // cells をリプレイして局面・着手ログ・HP・終了状態を導出する
  function rebuild() {
    var board = E.initialBoard();
    var marks = E.initialMarks();
    var player = BLACK;
    var plies = 0, lastPass = false, lastMove = -1;
    var log = [];      // {player, cell, R, C, D} または {player, pass:true}
    var pts = [0, 0, 0];

    function pass() { // パスは1手消費・与ダメ0
      log.push({ player: player, pass: true });
      lastPass = true;
      player = 3 - player;
      plies++;
    }

    for (var i = 0; i < cells.length; i++) {
      // 打てない手番は自動パス。連続パスは終局なので、着手の前に来るのは高々1回
      var moves = E.movesFor(board, player);
      if (moves.length === 0) { pass(); moves = E.movesFor(board, player); }
      var mv = null;
      for (var k = 0; k < moves.length; k++) {
        if (moves[k].move === cells[i]) { mv = moves[k]; break; }
      }
      if (!mv) throw new Error('リプレイ不能な着手: ' + E.cellName(cells[i]));
      var R = mv.flips.length;
      var C = E.markedAnchors(marks, mv);          // 着手前に判定（アンカーは反転されない）
      E.applyMove(board, marks, player, mv);
      var D = E.isGuaranteedCombo(board, mv.move); // 確定コンボは着手後の盤面で判定
      log.push({ player: player, cell: mv.move, R: R, C: C, D: D });
      pts[player] += gainOf(player, R, C, D);
      lastMove = mv.move;
      lastPass = false;
      player = 3 - player;
      plies++;
    }

    // 残り HP = 初期HP − 相手の与ダメージ計（初期HPは黒白別・0未満も負値のまま）
    var hp = [0, 0, 0];
    hp[BLACK] = initialHP(BLACK) - pts[WHITE];
    hp[WHITE] = initialHP(WHITE) - pts[BLACK];

    var full = true;
    for (var m = 0; m < E.CELLS; m++) {
      if (board[m] === EMPTY) { full = false; break; }
    }
    var over = full || hp[BLACK] <= 0 || hp[WHITE] <= 0;
    var doublePass = false;
    // 終局していなければ手番の自動パスを解決。両者連続パスなら盤面決着
    while (!over && E.movesFor(board, player).length === 0) {
      if (lastPass) { doublePass = true; over = true; break; }
      pass();
    }

    return { board: board, marks: marks, player: player, plies: plies,
             lastPass: lastPass, doublePass: doublePass, over: over,
             lastMove: lastMove, log: log, hp: hp };
  }

  function refresh() {
    pos = rebuild();
    render();
    analyze();
  }

  function playCell(cell) { cells.push(cell); refresh(); }

  function undo() {
    // 自動パスは導出値なので、着手を1つ消せば前後のパスも一緒に戻る
    if (cells.length > 0) { cells.pop(); refresh(); }
  }

  function newGame() { cells = []; refresh(); } // 設定（初期HP・式）は維持

  /* ---------------- 表示 ---------------- */

  function fmtPt(x) {
    return Math.round(x).toLocaleString('ja-JP');
  }

  function fmtBadge(x) {
    if (x >= 100000) return Math.round(x / 1000) + 'k';
    if (x >= 10000) return (x / 1000).toFixed(1) + 'k';
    return String(Math.round(x));
  }

  function render() {
    boardEl.innerHTML = '';
    var moves = pos.over ? [] : E.movesFor(pos.board, pos.player);
    var movesByCell = {};
    var tmpB = new Uint8Array(pos.board), tmpM = new Uint8Array(pos.marks);
    for (var k = 0; k < moves.length; k++) {
      var mv = moves[k];
      mv.C = E.markedAnchors(pos.marks, mv);
      // D（確定コンボ）は着手後の盤面が必要なため、コピー上で試し打ちして判定
      E.applyMove(tmpB, tmpM, pos.player, mv);
      mv.D = E.isGuaranteedCombo(tmpB, mv.move);
      E.undoMove(tmpB, tmpM, pos.player, mv);
      mv.gain = gainOf(pos.player, mv.flips.length, mv.C, mv.D);
      movesByCell[mv.move] = mv;
    }

    for (var m = 0; m < E.CELLS; m++) {
      var cell = document.createElement('div');
      cell.className = 'cell';
      var v = pos.board[m];
      if (v !== EMPTY) {
        var stone = document.createElement('div');
        stone.className = 'stone ' + (v === BLACK ? 'black' : 'white') +
                          (pos.marks[m] ? ' marked' : '');
        cell.appendChild(stone);
      } else if (movesByCell[m]) {
        cell.classList.add('playable');
        if (movesByCell[m].C > 0) cell.classList.add('combo');
        var badge = document.createElement('span');
        badge.className = 'hint-gain';
        badge.textContent = '+' + fmtBadge(movesByCell[m].gain);
        cell.appendChild(badge);
        var rcd = document.createElement('span');
        rcd.className = 'hint-rcd';
        rcd.textContent = 'R' + movesByCell[m].flips.length +
                          ' C' + movesByCell[m].C +
                          ' D' + movesByCell[m].D;
        cell.appendChild(rcd);
        (function (move) {
          cell.addEventListener('click', function () { playCell(move); });
        })(m);
      }
      if (m === pos.lastMove) cell.classList.add('last-move');
      cell.dataset.cell = m;
      boardEl.appendChild(cell);
    }

    ptsBlackEl.textContent = fmtPt(pos.hp[BLACK]);
    ptsWhiteEl.textContent = fmtPt(pos.hp[WHITE]);
    scoreBlackEl.classList.toggle('active', !pos.over && pos.player === BLACK);
    scoreWhiteEl.classList.toggle('active', !pos.over && pos.player === WHITE);

    turnInfoEl.textContent = 'ターン ' + (Math.floor(pos.plies / 2) + 1) +
      '\n(' + pos.plies + '手目まで)';

    if (pos.over) {
      var msg;
      if (pos.hp[WHITE] <= 0) msg = '黒の勝ち！（白のHPが尽きた）';
      else if (pos.hp[BLACK] <= 0) msg = '白の勝ち！（黒のHPが尽きた）';
      else {
        var d = pos.hp[BLACK] - pos.hp[WHITE];
        msg = (d > 0 ? '黒の勝ち！' : d < 0 ? '白の勝ち！' : '引き分け') + '（盤面決着・残りHP差）';
      }
      statusEl.innerHTML = 'ゲーム終了 — <b>' + msg + '</b>';
    } else {
      statusEl.textContent = playerName(pos.player) + 'の番です';
    }

    btnUndo.disabled = cells.length === 0;
    btnBest.disabled = true; // 解析完了後に有効化
  }

  /* ---------------- 解析（Web Worker） ---------------- */

  function analyze() {
    if (worker) { worker.terminate(); worker = null; }
    latestBest = null;
    analysisToken++;

    if (pos.over) {
      evalMainEl.textContent = '最終HP差（黒−白）: ' +
        ((pos.hp[BLACK] - pos.hp[WHITE]) > 0 ? '+' : '') + fmtPt(pos.hp[BLACK] - pos.hp[WHITE]);
      evalDetailEl.textContent = 'ゲーム終了局面です。';
      evalProgressEl.textContent = '';
      return;
    }

    // 読みの地平はゲーム開始から16手目に固定。深さ上限 = 16 − 経過手数
    var empties = 0;
    for (var i = 0; i < E.CELLS; i++) if (pos.board[i] === EMPTY) empties++;
    var maxPlies = Math.max(1, Math.min(empties * 2 + 1, 16 - pos.plies));

    // 初期局面は4回対称で初手4候補は同価値のため、推奨手は d5 に固定し、
    // 探索も d5 の1手に絞る（評価値は全候補を読んだ場合と同値、探索量は約1/4）
    var rootMove = pos.plies === 0 ? 27 : -1; // 27 = d5
    analysisNote = rootMove >= 0 ?
      '初期局面は対称（初手4候補は同価値）のため、d5 に絞って解析しています。' : '';

    evalMainEl.textContent = '計算中…';
    evalDetailEl.textContent = analysisNote;
    evalProgressEl.textContent = '';

    var token = analysisToken;
    worker = new Worker('worker.js');
    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.token !== token) return;
      if (msg.type === 'progress') {
        showAnalysis(msg.result, maxPlies);
      } else if (msg.type === 'done') {
        evalProgressEl.textContent = evalProgressEl.textContent.replace('計算中', '完了');
      }
    };
    worker.postMessage({
      token: token,
      board: pos.board,   // Uint8Array は structured clone でコピーされる
      marks: pos.marks,
      player: pos.player,
      maxPlies: maxPlies,
      passed: pos.lastPass,
      hpMe: pos.hp[pos.player],
      hpOpp: pos.hp[3 - pos.player],
      formulaBlack: formulas[BLACK],
      formulaWhite: formulas[WHITE],
      rootMove: rootMove
      // 時間上限なし（読み切るまで計算。途中経過は随時表示される）
    });

    if (rootMove >= 0) {
      // 推奨手は探索を待たずに確定しているので、先に表示して打てるようにする
      boardEl.children[rootMove].classList.add('best-move');
      latestBest = { token: token, move: rootMove };
      btnBest.disabled = false;
    }
  }

  function showAnalysis(res, maxPlies) {
    var p = pos.player;
    if (Math.abs(res.value) > E.WIN / 2) {
      // 勝敗確定（KO までの読み切り）。値には最終HP差も入っている
      var winner = res.value > 0 ? p : 3 - p;
      var moverDiff = res.value > 0 ? res.value - E.WIN : res.value + E.WIN;
      var koDiffBlack = p === BLACK ? moverDiff : -moverDiff;
      evalMainEl.textContent = playerName(winner) + 'の勝ち確定（KO） ' +
        (koDiffBlack > 0 ? '+' : '') + fmtPt(koDiffBlack);
      evalDetailEl.textContent =
        '双方最善なら' + playerName(winner) + 'が先に相手のHPを削り切ります。\n' +
        '最終HP差（黒−白）: ' + (koDiffBlack > 0 ? '+' : '') + fmtPt(koDiffBlack) + '\n' +
        (res.bestMove >= 0 ? '推奨手: ' + E.cellName(res.bestMove) : '') +
        (analysisNote ? '\n' + analysisNote : '');
    } else {
      // res.value は手番側から見た「最終 HP 差」（現在 HP を織り込み済み）
      var diffBlack = p === BLACK ? res.value : -res.value;
      var verdict = diffBlack > 0 ? '黒有利' : diffBlack < 0 ? '白有利' : '互角';
      evalMainEl.textContent = '最終HP差（黒−白）: ' +
        (diffBlack > 0 ? '+' : '') + fmtPt(diffBlack) + (res.solved ? '' : '（暫定）');
      evalDetailEl.textContent =
        '両者最善時、' + verdict + '。\n' +
        (res.bestMove >= 0 ? '推奨手: ' + E.cellName(res.bestMove) : '') +
        (analysisNote ? '\n' + analysisNote : '');
    }
    evalProgressEl.textContent = (res.solved ? '読み切り' : '計算中') +
      ' 深さ ' + res.depth + '/' + maxPlies +
      ' | ' + res.nodes.toLocaleString() + ' ノード | ' + res.ms + ' ms';

    var cellEls = boardEl.children;
    for (var i = 0; i < cellEls.length; i++) cellEls[i].classList.remove('best-move');
    if (res.bestMove >= 0 && !pos.over) {
      cellEls[res.bestMove].classList.add('best-move');
      latestBest = { token: analysisToken, move: res.bestMove };
      btnBest.disabled = false;
    }
  }

  function playBest() {
    // トークンが一致する間は局面が変わっていないので、推奨手はそのまま合法
    if (!latestBest || latestBest.token !== analysisToken || pos.over) return;
    playCell(latestBest.move);
  }

  /* ---------------- イベント ---------------- */

  btnNew.addEventListener('click', newGame);
  btnRestart.addEventListener('click', newGame); // 盤面を初期化（設定は維持）
  btnUndo.addEventListener('click', undo);
  btnBest.addEventListener('click', playBest);

  [BLACK, WHITE].forEach(function (player) {
    // 初期HPの変更は現在の対局にも即反映（HPは導出値なので再計算するだけ）
    hpInputEls[player].addEventListener('change', refresh);
  });

  // 初期HP ±5000 ボタン（input の値を直接書き換えて refresh するだけ。HP自体は導出値なので触らない）
  Array.prototype.forEach.call(document.querySelectorAll('.hp-step'), function (btn) {
    var player = btn.dataset.hp === 'black' ? BLACK : WHITE;
    var delta = parseInt(btn.dataset.delta, 10);
    btn.addEventListener('click', function () {
      var next = initialHP(player) + delta;
      hpInputEls[player].value = Math.max(1, next);
      refresh();
    });
  });

  [BLACK, WHITE].forEach(function (player) {
    var selectEl = presetSelectEls[player], inputEl = formulaInputEls[player];
    selectEl.addEventListener('change', function () {
      var key = selectEl.value;
      if (PRESETS[key]) {
        inputEl.value = PRESETS[key];
        applyFormula(player, PRESETS[key]);
      }
      // 「カスタム」選択時は入力欄の編集を待つ
    });
    inputEl.addEventListener('change', function () {
      var expr = inputEl.value.trim();
      if (!expr) return;
      // 手入力された式がプリセットと一致しなければ「カスタム」に切り替え
      var key = Object.keys(PRESETS).find(function (k) { return PRESETS[k] === expr; });
      selectEl.value = key || 'custom';
      applyFormula(player, expr);
    });
  });

  newGame();
})();
