/*
 * engine.js — 6x6 リバーシのゲームロジックと探索エンジン
 *
 * ルールと探索仕様の詳細は docs/SPEC.md を参照（ここには重複記載しない）。
 * メインスレッド（UI）と Web Worker（探索）の両方から読み込まれるため、
 * DOM やグローバル環境には依存しない。
 */
(function (root, factory) {
  var E = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  else root.Engine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIZE = 6, CELLS = 36;
  var EMPTY = 0, BLACK = 1, WHITE = 2;

  // 各マスから8方向へ伸びるレイを前計算
  var DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  var RAYS = []; // RAYS[cell] = 8本のレイ（外側へ向かうマス番号の配列）
  for (var r = 0; r < SIZE; r++) {
    for (var c = 0; c < SIZE; c++) {
      var rays = [];
      for (var d = 0; d < 8; d++) {
        var dr = DIRS[d][0], dc = DIRS[d][1];
        var ray = [];
        var rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) {
          ray.push(rr * SIZE + cc);
          rr += dr; cc += dc;
        }
        rays.push(ray);
      }
      RAYS.push(rays);
    }
  }

  function initialBoard() {
    var b = new Uint8Array(CELLS);
    b[14] = WHITE; b[15] = BLACK;
    b[20] = BLACK; b[21] = WHITE;
    return b;
  }

  function initialMarks() {
    return new Uint8Array(CELLS); // 初期石は無印
  }

  // player の合法手一覧（{move, flips[], anchors[]}）
  // anchors = 各反転ラインの反対側の端にある自分の石（挟んでいる石）
  function movesFor(board, player) {
    var opp = 3 - player, out = [];
    for (var m = 0; m < CELLS; m++) {
      if (board[m] !== EMPTY) continue;
      var flips = null, anchors = null;
      var rays = RAYS[m];
      for (var d = 0; d < 8; d++) {
        var ray = rays[d], len = ray.length;
        var i = 0;
        while (i < len && board[ray[i]] === opp) i++;
        if (i > 0 && i < len && board[ray[i]] === player) {
          if (!flips) { flips = []; anchors = []; }
          for (var j = 0; j < i; j++) flips.push(ray[j]);
          anchors.push(ray[i]);
        }
      }
      if (flips) out.push({ move: m, flips: flips, anchors: anchors });
    }
    return out;
  }

  // 着手を適用。打った石にマークを付け、反転された石のマークを消す。
  // 消したマークのマス一覧を mv.cleared に記録する（undo 用）。
  function applyMove(board, marks, player, mv) {
    board[mv.move] = player;
    marks[mv.move] = 1;
    mv.cleared = null;
    for (var i = 0; i < mv.flips.length; i++) {
      var f = mv.flips[i];
      board[f] = player;
      if (marks[f]) {
        marks[f] = 0;
        if (!mv.cleared) mv.cleared = [];
        mv.cleared.push(f);
      }
    }
  }

  function undoMove(board, marks, player, mv) {
    board[mv.move] = EMPTY;
    marks[mv.move] = 0;
    var opp = 3 - player;
    for (var i = 0; i < mv.flips.length; i++) board[mv.flips[i]] = opp;
    if (mv.cleared) {
      for (var j = 0; j < mv.cleared.length; j++) marks[mv.cleared[j]] = 1;
    }
  }

  // コンボ数 C = マーク石で挟んだライン数。
  // 挟んでいる石（アンカー）は反転されないため、着手の適用前後どちらでも
  // 同じ結果になる（判定は着手前のマーク状態で行うこと）。
  function markedAnchors(marks, mv) {
    var count = 0;
    for (var i = 0; i < mv.anchors.length; i++) {
      if (marks[mv.anchors[i]]) count++;
    }
    return count;
  }

  /* ---------------- 確定コンボ D の判定 ---------------- */

  // DIRS の向かい合う方向のペア = 4軸（横・縦・斜め2本）
  var AXIS_PAIRS = [[0, 7], [1, 6], [2, 5], [3, 4]];

  // ray 方向へ x と同色の石をたどり、最初に現れた「同色でないもの」を返す。
  // 戻り値: EMPTY(空きマス) / 相手の色 / -1(壁まで同色が続いた)
  function rayEnd(board, ray, color) {
    for (var i = 0; i < ray.length; i++) {
      if (board[ray[i]] !== color) return board[ray[i]];
    }
    return -1;
  }

  // 打った石 x が相手の「次の 1 手」で返され得ないか。
  // 相手が x を返すには、x からある方向へ同色の石が連続した先が空きマス
  // （そこに相手が置く）、逆方向へ連続した先が相手の石（アンカー）という
  // 直線が必要。これがどの軸にも無ければ次の 1 手では返されない。
  function safeNextTurn(board, x) {
    var color = board[x], opp = 3 - color;
    var rays = RAYS[x];
    for (var a = 0; a < 4; a++) {
      var endA = rayEnd(board, rays[AXIS_PAIRS[a][0]], color);
      var endB = rayEnd(board, rays[AXIS_PAIRS[a][1]], color);
      if ((endA === EMPTY && endB === opp) || (endB === EMPTY && endA === opp)) return 0;
    }
    return 1;
  }

  // x を起点（アンカー）にしたコンボ手が存在するか。
  // x からある方向に相手の石が 1 つ以上連続し、その先が空きマスなら、
  // そこに打つことで x と挟んで返せる（x はマーク石なのでコンボになる）。
  function comboAvailableFrom(board, x) {
    var opp = 3 - board[x];
    var rays = RAYS[x];
    for (var d = 0; d < 8; d++) {
      var ray = rays[d], len = ray.length;
      var i = 0;
      while (i < len && board[ray[i]] === opp) i++;
      if (i > 0 && i < len && board[ray[i]] === EMPTY) return true;
    }
    return false;
  }

  // 1マスだけの合法手判定（movesFor の単一マス版）。合法なら {move, flips} を返す
  function moveAt(board, player, m) {
    if (board[m] !== EMPTY) return null;
    var opp = 3 - player, flips = null;
    var rays = RAYS[m];
    for (var d = 0; d < 8; d++) {
      var ray = rays[d], len = ray.length;
      var i = 0;
      while (i < len && board[ray[i]] === opp) i++;
      if (i > 0 && i < len && board[ray[i]] === player) {
        if (!flips) flips = [];
        for (var j = 0; j < i; j++) flips.push(ray[j]);
      }
    }
    return flips ? { move: m, flips: flips } : null;
  }

  // 確定コンボ判定 D: 打った石 x が
  //  (1) 相手の次の 1 手では返されず、かつ
  //  (2) 相手がどう応じても、次の自分の手番で x を起点にコンボできる
  // 場合に 1。
  //
  // 高速化の要点: comboAvailableFrom(board, x) が読むのは各レイの
  // 「相手色の連続（プレフィックス）＋その先の停止マス」だけ。相手は自分の色の
  // 石を返せないため、プレフィックスは相手の応手で変化しない。つまり判定を
  // 変え得る応手は「空きの停止マスへの着手」か「自分（x側）の色の停止マスを
  // 返す着手」だけであり、相手の全手生成なしで候補を直接列挙できる。
  var scratchMarks = new Uint8Array(CELLS); // apply/undo 用（マークの値は判定に無関係）
  var candStamp = new Int32Array(CELLS), candTick = 0; // 候補マスの重複排除用
  function isGuaranteedCombo(board, x) {
    if (!safeNextTurn(board, x)) return 0;
    var mine = board[x], opp = 3 - mine;
    var rays = RAYS[x];

    // base（現盤面でコンボ手があるか）と停止マスの収集
    var base = false;
    var stops = [], nStops = 0;
    var d, i, ray, len;
    for (d = 0; d < 8; d++) {
      ray = rays[d]; len = ray.length;
      i = 0;
      while (i < len && board[ray[i]] === opp) i++;
      if (i < len) {
        stops[nStops++] = ray[i];
        if (i > 0 && board[ray[i]] === EMPTY) base = true;
      }
    }

    if (!base) {
      // 現状コンボ手なし。停止マスに絡まない応手はコンボ不可のままなので、
      // そのような合法応手が1つ見つかった時点で D=0（早期脱出）。
      // 停止マスに絡む応手だけ仮に打って確認する
      candTick++;
      for (i = 0; i < nStops; i++) candStamp[stops[i]] = candTick;
      var found = false;
      for (var m = 0; m < CELLS; m++) {
        if (board[m] !== EMPTY) continue;
        var o0 = moveAt(board, opp, m);
        if (!o0) continue;
        found = true;
        var touches = candStamp[m] === candTick; // 空き停止マスへの着手か
        for (var j = 0; j < o0.flips.length && !touches; j++) {
          if (candStamp[o0.flips[j]] === candTick) touches = true;
        }
        if (!touches) return 0; // この応手ではコンボ不可のまま
        if (!keepsCombo(board, opp, o0, x)) return 0;
      }
      return found ? 1 : 0; // 応手なし（パス）なら base=false のまま → 0
    }

    // base=true: 停止マスに絡む応手だけがコンボを消し得る。候補を直接列挙する
    candTick++;
    for (var s = 0; s < nStops; s++) {
      var stop = stops[s];
      if (board[stop] === EMPTY) {
        // 空きの停止マスへの相手の着手
        if (candStamp[stop] !== candTick) {
          candStamp[stop] = candTick;
          var o1 = moveAt(board, opp, stop);
          if (o1 && !keepsCombo(board, opp, o1, x)) return 0;
        }
      } else {
        // 自分（x側）の色の停止マス → これを返す相手の着手を列挙:
        // ある軸で [空きマス e][x側の色の連続（stopを含む）][相手のアンカー]
        for (var a = 0; a < 4; a++) {
          var rayA = RAYS[stop][AXIS_PAIRS[a][0]], rayB = RAYS[stop][AXIS_PAIRS[a][1]];
          var endA = rayEnd(board, rayA, mine), endB = rayEnd(board, rayB, mine);
          var e = -1;
          if (endA === EMPTY && endB === opp) e = rayEndCell(board, rayA, mine);
          else if (endB === EMPTY && endA === opp) e = rayEndCell(board, rayB, mine);
          if (e >= 0 && candStamp[e] !== candTick) {
            candStamp[e] = candTick;
            var o2 = moveAt(board, opp, e);
            if (o2 && !keepsCombo(board, opp, o2, x)) return 0;
          }
        }
      }
    }
    return 1;
  }

  // ray 方向へ color の石をたどり、最初に現れた「color でないマス」の番号を返す
  function rayEndCell(board, ray, color) {
    for (var i = 0; i < ray.length; i++) {
      if (board[ray[i]] !== color) return ray[i];
    }
    return -1;
  }

  // 応手 o を仮に打っても x 起点のコンボ手が残るか
  function keepsCombo(board, opp, o, x) {
    applyMove(board, scratchMarks, opp, o);
    var ok = comboAvailableFrom(board, x);
    undoMove(board, scratchMarks, opp, o);
    return ok;
  }

  /* ---------------- 探索（αβ + 置換表 + 反復深化） ---------------- */

  // ポイント式 f(R, C, D) の文字列を関数にコンパイルする（UI と Worker で共用）。
  // 構文エラーや数値を返さない式はここで例外になる
  function compileFormula(expr) {
    var fn = new Function('R', 'C', 'D', '"use strict"; return (' + expr + ');');
    // 代表値で検証（例外や非数が出る式は弾く）
    var probe = fn(1, 0, 0) + fn(3, 2, 1) + fn(10, 8, 0);
    if (!isFinite(probe)) throw new Error('式の結果が数値になりません');
    return fn;
  }

  // 獲得ポイントはユーザー定義式のため実数。ポイント式は黒と白で別々に持てる。
  // R∈[1,36], C∈[0,8], D∈{0,1} の全組み合わせをプレイヤーごとに探索前に
  // テーブル化して、探索中の式評価コストをなくす。
  // どちらの式も D（確定コンボ）を使わない場合は usesD=false になり、
  // 探索中の確定コンボ判定を丸ごと省略できる。
  var gainTables = null, usesD = false;
  function buildGainTables(gainFnBlack, gainFnWhite) {
    gainTables = [null, new Float64Array(37 * 9 * 2), new Float64Array(37 * 9 * 2)];
    usesD = false;
    var fns = [null, gainFnBlack, gainFnWhite];
    for (var p = 1; p <= 2; p++) {
      var tbl = gainTables[p], fn = fns[p];
      for (var R = 1; R <= 36; R++) {
        for (var C = 0; C <= 8; C++) {
          for (var D = 0; D <= 1; D++) {
            var v = Number(fn(R, C, D));
            tbl[(R * 9 + C) * 2 + D] = isFinite(v) ? v : 0;
          }
          if (tbl[(R * 9 + C) * 2] !== tbl[(R * 9 + C) * 2 + 1]) usesD = true;
        }
      }
    }
  }

  // 置換表: キー = 盤面(2bit×36) + マーク(1bit×36) + (手番|パスフラグ) を9文字にパック
  // 値は実数のためオブジェクトで保持 {p: 残り手数, v: 値, f: フラグ, m: 最善手}
  var TT = null, ttNodes = 0;
  var FLAG_EXACT = 0, FLAG_LOWER = 1, FLAG_UPPER = 2;

  function timeNow() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  function packKey(board, marks, player, passed) {
    var c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, m0 = 0, m1 = 0, m2 = 0, i;
    for (i = 0; i < 8; i++)   c0 = c0 * 4 + board[i];
    for (i = 8; i < 16; i++)  c1 = c1 * 4 + board[i];
    for (i = 16; i < 24; i++) c2 = c2 * 4 + board[i];
    for (i = 24; i < 32; i++) c3 = c3 * 4 + board[i];
    for (i = 32; i < 36; i++) c4 = c4 * 4 + board[i];
    for (i = 0; i < 16; i++)  m0 = m0 * 2 + marks[i];
    for (i = 16; i < 32; i++) m1 = m1 * 2 + marks[i];
    for (i = 32; i < 36; i++) m2 = m2 * 2 + marks[i];
    return String.fromCharCode(c0, c1, c2, c3, c4, m0, m1, m2,
                               player * 2 + (passed ? 1 : 0));
  }

  // 勝ち確定（KO）のオフセット。HP 差やダメージとは桁違いに大きくしておく。
  // KO 時の値は WIN + 最終HP差 とし、勝ち筋の中でも HP 差が最大の手を選ぶ
  var WIN = 1e15;

  // 相手（opp）の最善 = 最大ダメージの 1 手分。KO 後のラウンド完結用
  function bestResponseDamage(board, marks, opp) {
    var moves = movesFor(board, opp);
    var tbl = gainTables[opp];
    var best = 0;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var rc = (m.flips.length * 9 + markedAnchors(marks, m)) * 2;
      var g;
      if (usesD) {
        applyMove(board, marks, opp, m);
        g = isGuaranteedCombo(board, m.move) ? tbl[rc + 1] : tbl[rc];
        undoMove(board, marks, opp, m);
      } else {
        g = tbl[rc];
      }
      if (g > best) best = g;
    }
    return best;
  }

  /*
   * value = 手番側から見た「双方最善時の最終 HP 差」。
   *  - 読みの範囲内で KO（与ダメ >= 相手 HP）を強制できるなら
   *    ±(WIN + 最終HP差)。HP はクリップせず、オーバーキル分も差に含める
   *  - 水平線（plies=0）・盤面決着（両者連続パス）では現在の HP 差
   * ダメージは myHP/oppHP の状態として流れるので、αβ の窓は通常の (-β, -α)
   */
  function negamax(board, marks, player, plies, passed, myHP, oppHP, alpha, beta, forcedMove) {
    if (plies === 0) return myHP - oppHP;
    ttNodes++;

    var key = packKey(board, marks, player, passed);
    var entry = TT.get(key);
    var hintMove = -1;
    if (entry !== undefined) {
      hintMove = entry.m;
      // 同じ盤面でも HP が違えば価値が違うため、HP まで一致した場合のみ値を使う
      if (entry.p === plies && entry.h1 === myHP && entry.h2 === oppHP) {
        if (entry.f === FLAG_EXACT) return entry.v;
        if (entry.f === FLAG_LOWER) {
          if (entry.v >= beta) return entry.v;
          if (entry.v > alpha) alpha = entry.v;
        } else {
          if (entry.v <= alpha) return entry.v;
          if (entry.v < beta) beta = entry.v;
        }
      }
    }

    var moves = movesFor(board, player);
    if (moves.length === 0) {
      // パス（1手消費・与ダメ0）。両者連続パスなら盤面決着 → HP差
      if (passed) return myHP - oppHP;
      return -negamax(board, marks, 3 - player, plies - 1, true, oppHP, myHP, -beta, -alpha, -1);
    }

    // root の候補手を1手に固定（solve から渡される。初期局面の対称性対策）
    if (forcedMove >= 0) {
      for (var fm = 0; fm < moves.length; fm++) {
        if (moves[fm].move === forcedMove) { moves = [moves[fm]]; break; }
      }
    }

    // 各手の与ダメージを先に求め、並べ替えに使う（TTの手 > KO手 > 高ダメージ > 反転数）
    // ※ R,C はアンカーが反転されないため着手前に判定できる。
    //    D（確定コンボ）だけは着手後の盤面が必要なので、並べ替えは D=0 の近似値で行う
    var i, mv;
    var tbl = gainTables[player];
    for (i = 0; i < moves.length; i++) {
      mv = moves[i];
      mv.rc = (mv.flips.length * 9 + markedAnchors(marks, mv)) * 2;
      mv.gain0 = tbl[mv.rc];
      mv.order = (mv.move === hintMove ? Infinity :
                  (mv.gain0 >= oppHP ? 1e30 : mv.gain0 * 4 + mv.flips.length));
    }
    moves.sort(function (a, b) { return b.order - a.order; });

    var alpha0 = alpha, best = -Infinity, bestMove = -1;
    for (i = 0; i < moves.length; i++) {
      mv = moves[i];
      applyMove(board, marks, player, mv);
      var g = (usesD && isGuaranteedCombo(board, mv.move)) ? tbl[mv.rc + 1] : mv.gain0;
      var v;
      if (g >= oppHP) {
        // KO — 勝ち確定 + 最終HP差（オーバーキル込み）。
        // 黒はラウンドの先手なので、黒の KO では相手（白）の同一ラウンドの
        // 1 手が残っている。その最善（最大ダメージ）の応手を受けた上で
        // 2 ターン分の HP 差を計算する。白の KO はラウンド完結なのでそのまま
        var diff = myHP - (oppHP - g);
        if (player === BLACK) diff -= bestResponseDamage(board, marks, WHITE);
        v = WIN + diff;
      } else {
        v = -negamax(board, marks, 3 - player, plies - 1, false, oppHP - g, myHP, -beta, -alpha, -1);
      }
      undoMove(board, marks, player, mv);
      if (v > best) {
        best = v;
        bestMove = mv.move;
        if (v > alpha) alpha = v;
      }
      if (alpha >= beta) break;
    }

    var flag = best <= alpha0 ? FLAG_UPPER : (best >= beta ? FLAG_LOWER : FLAG_EXACT);
    if (TT.size > 2000000) TT.clear();
    TT.set(key, { p: plies, v: best, f: flag, m: bestMove, h1: myHP, h2: oppHP });
    return best;
  }

  /*
   * 反復深化で読み切る。maxPlies は読みの深さ上限。
   * gainFnBlack / gainFnWhite は各プレイヤーの 1 手の与ダメージ f(R, C, D)。
   * myHP / oppHP は手番側 / 相手の現在 HP。
   * onProgress({depth, value, bestMove, nodes, ms, solved}) を深さごとに呼ぶ。
   * 勝敗が確定（|value| > WIN/2）したら打ち切る。
   * forcedRootMove（省略可）を指定すると root の候補をその1手に絞る。
   * 対称で同価値の候補しかない局面（初期局面）で探索量を減らすためのもので、
   * 評価値は全候補を読んだ場合と同値になる。
   */
  function solve(board, marks, player, maxPlies, passed, myHP, oppHP,
                 gainFnBlack, gainFnWhite, onProgress, forcedRootMove) {
    buildGainTables(gainFnBlack, gainFnWhite);
    TT = new Map();
    ttNodes = 0;
    var b = new Uint8Array(board);
    var mk = new Uint8Array(marks);
    var forced = forcedRootMove >= 0 ? forcedRootMove : -1;
    var start = timeNow();
    var result = { depth: 0, value: myHP - oppHP, bestMove: -1, nodes: 0, ms: 0, solved: false };
    for (var d = 1; d <= maxPlies; d++) {
      var value = negamax(b, mk, player, d, passed, myHP, oppHP, -Infinity, Infinity, forced);
      var entry = TT.get(packKey(b, mk, player, passed));
      var bestMove = entry !== undefined ? entry.m : -1;
      var solved = d >= maxPlies || Math.abs(value) > WIN / 2;
      result = { depth: d, value: value, bestMove: bestMove, nodes: ttNodes,
                 ms: Math.round(timeNow() - start), solved: solved };
      if (onProgress) onProgress(result);
      if (solved) break;
    }
    TT = null; // メモリ解放
    return result;
  }

  function cellName(m) {
    return String.fromCharCode(97 + (m % SIZE)) + (Math.floor(m / SIZE) + 1);
  }

  return {
    SIZE: SIZE, CELLS: CELLS, EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE,
    initialBoard: initialBoard, initialMarks: initialMarks, movesFor: movesFor,
    applyMove: applyMove, undoMove: undoMove,
    markedAnchors: markedAnchors, safeNextTurn: safeNextTurn,
    comboAvailableFrom: comboAvailableFrom, isGuaranteedCombo: isGuaranteedCombo,
    compileFormula: compileFormula,
    solve: solve, cellName: cellName, WIN: WIN
  };
});
