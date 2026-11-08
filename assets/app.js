/* Вайб-квиз — движок тренажёра.
 * Без фреймворков и сборки: vanilla JS, localStorage, без сети.
 *
 * Правила ядра:
 *  - вопрос один, вариантов 2 (по умолчанию) или 4;
 *  - неверный ответ: правильный вариант подсвечивается, снизу разбор
 *    (определение → простыми словами → пример → подвох), карточка
 *    возвращается в очередь этой же сессии;
 *  - дистракторы — «похожие» термины той же категории и того же вида,
 *    ранжирование по лексической близости, порядок детерминирован сием сеанса;
 *  - SRS: ящики Лейтнера 0–5, интервалы [0,1,2,4,8,16] дней;
 *  - прогресс пишется в localStorage после каждого ответа.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "vibe-quiz.progress.v1";
  var BOX_INTERVALS_DAYS = [0, 1, 2, 4, 8, 16];
  var REQUEUE_OFFSET = 3;          // возвращение неверной карточки через N позиций
  var QUICK_SIZE = 10, EXAM_SIZE = 20, WEAK_SIZE = 10;
  var SESSIONS_KEPT = 50;
  var KIND_LABELS = {
    quick: "Быстрая сессия", category: "По категории",
    weak: "Слабые места", exam: "Экзамен", phrases: "Фразы для агента",
  };

  // ---------- Утилиты ----------

  function $(id) { return document.getElementById(id); }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rnd) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function dayIndex(ts) { return Math.floor(ts / 86400000); }

  function todayLocal() {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) +
      " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- Состояние ----------

  var bank = null;                  // terms.json
  var settings = { options: 2, direction: "term-def", dailyGoal: 20 };
  var progress = { terms: {}, sessions: [], daily: {} }; // daily: day -> count
  var storageOk = true;
  var session = null;               // активная сессия или null

  function defaultSettings() {
    return { options: 2, direction: "term-def", dailyGoal: 20 };
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.terms && parsed.sessions) {
          progress = {
            terms: parsed.terms,
            sessions: parsed.sessions.slice(-SESSIONS_KEPT),
            daily: parsed.daily || {},
          };
        }
      }
      var s = localStorage.getItem(STORAGE_KEY + ".settings");
      if (s) {
        var ps = JSON.parse(s);
        for (var k in defaultSettings()) {
          if (ps && ps[k] !== undefined) settings[k] = ps[k];
        }
      }
    } catch (e) {
      storageOk = false;
    }
    if (!storageOk) {
      var warn = $("storage-warn");
      warn.innerHTML = '<div class="warn-banner">Прогресс не сохранится: браузер в приватном режиме или localStorage недоступен.</div>';
    }
  }

  function saveState() {
    if (!storageOk) return;
    try {
      progress.sessions = progress.sessions.slice(-SESSIONS_KEPT);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
      localStorage.setItem(STORAGE_KEY + ".settings", JSON.stringify(settings));
    } catch (e) {
      if (e && /quota|security/i.test(String(e))) storageOk = false;
    }
  }

  // Восстановление из резервной копии при битом JSON — по плану.
  function initStorageDefensively() {
    try {
      localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageOk = false;
      return;
    }
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) JSON.parse(raw);
    } catch (e) {
      try {
        localStorage.setItem(STORAGE_KEY + ".bak", raw);
        localStorage.removeItem(STORAGE_KEY);
      } catch (e2) { /* пусто */ }
    }
  }

  function termState(id) {
    if (!progress.terms[id]) {
      progress.terms[id] = { box: 0, due: 0, seen: 0, correct: 0, wrong: 0, lastSeen: 0 };
    }
    return progress.terms[id];
  }

  // ---------- Банк ----------

  function loadBank(done) {
    if (window.VIBE_BANK) {         // автономный файл: банк вшит
      done(window.VIBE_BANK);
      return;
    }
    fetch("assets/data/terms.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(done)
      .catch(function (e) { showFatal(e); });
  }

  function showFatal(e) {
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    $("screen-error").classList.add("active");
    $("error-text").textContent = "Файл assets/data/terms.json не прочитан: " + (e && e.message ? e.message : e);
  }

  // ---------- Дистракторы ----------

  function tokens(text) {
    return text.toLowerCase().split(/[^a-zа-яё0-9+]+/).filter(function (t) { return t.length > 1; });
  }

  function similarity(a, b) {
    var ta = tokens(a.term), tb = tokens(b.term);
    var setA = {}, i;
    for (i = 0; i < ta.length; i++) setA[ta[i]] = true;
    var shared = 0;
    for (i = 0; i < tb.length; i++) if (setA[tb[i]]) shared++;
    var union = ta.length + tb.length - shared;
    var score = union ? shared / union : 0;
    if (a.kind === b.kind) score += 0.15;                 // команда против команды
    var la = a.term.length, lb = b.term.length;
    score += Math.max(0, 1 - Math.abs(la - lb) / Math.max(la, lb)) * 0.1;
    if (a.term.split(" ")[0] === b.term.split(" ")[0]) score += 0.3; // тот же первый токен (git …)
    return score;
  }

  function pickDistractors(answer, count, rnd, pool) {
    var candidates = pool.filter(function (t) { return t.id !== answer.id; });
    candidates.sort(function (x, y) {
      return similarity(answer, y) - similarity(answer, x);
    });
    var top = candidates.slice(0, Math.max(count * 3, count + 4)); // «близкие, но не самые очевидные»
    shuffle(top, rnd);
    return top.slice(0, count);
  }

  // ---------- Набор карточек сессии ----------

  function buildTermQueue(mode, category) {
    var pool = bank.terms;
    if (mode === "category") {
      pool = pool.filter(function (t) { return t.category === category; });
    }
    var now = Date.now();
    var rnd = session.rnd;

    function dueFirst(a, b) {
      var sa = termState(a.id), sb = termState(b.id);
      if (sa.due <= now && sb.due <= now) return sa.box - sb.box;
      if (sa.due <= now) return -1;
      if (sb.due <= now) return 1;
      return sa.due - sb.due;
    }

    if (mode === "weak") {
      var scored = pool.map(function (t) {
        var s = termState(t.id);
        var bad = s.wrong / (s.seen || 1);
        return { t: t, key: s.seen === 0 ? -1 : bad };
      }).sort(function (a, b) { return b.key - a.key; });
      return shuffle(scored.slice(0, WEAK_SIZE).map(function (x) { return x.t; }), rnd);
    }

    var sorted = pool.slice().sort(dueFirst);
    var size = mode === "exam" ? EXAM_SIZE : QUICK_SIZE;
    return sorted.slice(0, size).map(function (t) { return t; });
  }

  // ---------- Сессия ----------

  function startSession(mode, category) {
    session = {
      mode: mode,
      category: category || null,
      rnd: mulberry32((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0),
      queue: [],
      answered: 0,
      totalPlanned: 0,
      correct: 0,
      wrongIds: {},
      byCategory: {},
      examLog: [],
      current: null,
      locked: false,
    };

    if (mode === "phrases") {
      var phrases = bank.phrases.slice();
      shuffle(phrases, session.rnd);
      session.queue = phrases.map(function (p) { return { phrase: p }; });
    } else {
      session.queue = buildTermQueue(mode, category).map(function (t) { return { term: t }; });
    }
    if (session.queue.length === 0) { showScreen("home"); return; }
    session.totalPlanned = session.queue.length;
    // Порядок вопросов — приоритет отбора (к повторению первым); внутри
    // «слабых мест» и фраз отбор уже перемешан.
    showScreen("session");
    nextCard();
  }

  function nextCard() {
    var card = session.queue.shift();
    if (!card) { finishSession(); return; }
    session.current = card;
    session.locked = false;
    renderCard(card);
  }

  function renderCard(card) {
    var isPhrase = !!card.phrase;
    var opts = settings.options;
    var questionText, kindLabel, pool, answer;

    if (isPhrase) {
      kindLabel = "Ситуация → фраза";
      questionText = "Когда пригодится: " + card.phrase.use;
      pool = bank.phrases;
      answer = card.phrase;
      $("q-text").className = "q-text";
    } else {
      var t = card.term;
      var dir = settings.direction;
      // Правильный выбор — сам термин: в нём есть и имя, и определение.
      answer = t;
      if (dir === "def-term") {
        kindLabel = "Определение → термин";
        questionText = t.definition;
      } else {
        kindLabel = "Термин → определение";
        questionText = t.term;
      }
      pool = bank.terms;
      $("q-text").className = "q-text" + (t.kind === "command" && dir === "term-def" ? " mono" : "");
    }

    $("q-kind").textContent = kindLabel;
    $("q-text").textContent = questionText;

    var catTitle = "";
    if (!isPhrase) {
      var cat = bank.categories.filter(function (c) { return c.id === card.term.category; })[0];
      catTitle = cat ? cat.title : "";
    }

    $("session-info").textContent =
      KIND_LABELS[session.mode] + (catTitle && session.mode !== "category" ? " · " + catTitle : "") +
      " · " + (session.answered + 1) + " / " + session.totalPlanned;

    var pct = Math.round((session.answered / session.totalPlanned) * 100);
    var bar = $("session-bar");
    bar.setAttribute("aria-valuenow", String(pct));
    bar.firstElementChild.style.width = pct + "%";

    // Варианты: правильный + дистракторы той же категории, общий перемешанный порядок.
    var distractors = isPhrase
      ? pickPhraseDistractors(answer, opts - 1, session.rnd)
      : pickDistractors(card.term, opts - 1, session.rnd,
          pool.filter(function (x) { return x.category === card.term.category; }));
    var choices = distractors.concat([answer]);
    shuffle(choices, session.rnd);

    var box = $("options");
    box.innerHTML = "";
    choices.forEach(function (choice, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option";
      var label = isPhrase ? choice.text
        : (settings.direction === "def-term" ? choice.term : choice.definition);
      btn.innerHTML = '<span class="key">' + (i + 1) + "</span><span>" + escapeHtml(label) + "</span>";
      btn.dataset.answerId = choice.id;
      btn.addEventListener("click", function () { answerPicked(btn, choice, isPhrase); });
      box.appendChild(btn);
    });

    $("feedback-slot").innerHTML = "";
  }

  function pickPhraseDistractors(answer, count, rnd) {
    var candidates = bank.phrases.filter(function (p) { return p.id !== answer.id; });
    shuffle(candidates, rnd);
    return candidates.slice(0, count);
  }

  function answerPicked(btn, choice, isPhrase) {
    if (session.locked) return;
    session.locked = true;
    var correct = isPhrase
      ? choice.id === session.current.phrase.id
      : choice.id === session.current.term.id;

    session.answered++;
    var day = String(dayIndex(Date.now()));
    progress.daily[day] = (progress.daily[day] || 0) + 1;

    var catId = isPhrase ? "phrases" : session.current.term.category;
    if (!session.byCategory[catId]) session.byCategory[catId] = { correct: 0, total: 0 };
    session.byCategory[catId].total++;

    if (session.mode === "exam") {
      // Экзамен: без показа правильного ответа, разбор в конце.
      session.examLog.push({
        card: session.current, chosenId: choice.id, correct: correct,
      });
      if (correct) session.correct++;
      else session.wrongIds[isPhrase ? session.current.phrase.id : session.current.term.id] = true;
      if (!isPhrase) applySrs(session.current.term.id, correct);
      saveState();
      setTimeout(nextCard, 120);
      return;
    }

    // Обычный режим: подсветка + разбор.
    var buttons = Array.prototype.slice.call(document.querySelectorAll("#options .option"));
    buttons.forEach(function (b) {
      b.disabled = true;
      var isRight = !isPhrase
        ? b.dataset.answerId === session.current.term.id
        : b.dataset.answerId === session.current.phrase.id;
      if (isRight) b.classList.add("correct");
      else if (b === btn) b.classList.add("wrong");
      else b.classList.add("dim");
    });

    if (correct) {
      session.correct++;
      session.byCategory[catId].correct++;
      renderFeedback(session.current, true, isPhrase, null);
    } else {
      session.wrongIds[isPhrase ? session.current.phrase.id : session.current.term.id] = true;
      renderFeedback(session.current, false, isPhrase, choice);
      // карточка возвращается в очередь сессии
      var requeue = session.current;
      var at = Math.min(REQUEUE_OFFSET, session.queue.length);
      session.queue.splice(at, 0, requeue);
      session.totalPlanned++; // план растёт: карточку спросим снова
    }
    if (!isPhrase) applySrs(session.current.term.id, correct);
    saveState();
  }

  function applySrs(termId, correct) {
    var s = termState(termId);
    s.seen++;
    s.lastSeen = Date.now();
    if (correct) {
      s.correct++;
      s.box = Math.min(BOX_INTERVALS_DAYS.length - 1, s.box + 1);
      s.due = todayLocal() + BOX_INTERVALS_DAYS[s.box] * 86400000;
    } else {
      s.wrong++;
      s.box = 0;
      s.due = Date.now(); // доступно к повторению сразу
    }
  }

  function renderFeedback(card, correct, isPhrase, chosen) {
    var slot = $("feedback-slot");
    var html;
    if (correct) {
      var why = "";
      if (!isPhrase && card.term.why) why = card.term.why;
      html = '<div class="feedback ok"><h3>Верно</h3>' +
        (why ? "<p>" + escapeHtml(why) + "</p>" : "") + "</div>";
    } else {
      var head, dl = "";
      if (isPhrase) {
        head = "<p><b>Правильная фраза:</b> " + escapeHtml(card.phrase.text) + "</p>";
      } else {
        var t = card.term, rows = [];
        head = settings.direction === "def-term"
          ? "<p><b>Правильный ответ:</b> <span class=\u0022mono\u0022>" + escapeHtml(t.term) + "</span></p>"
          : "<p><b>Правильный ответ:</b> " + escapeHtml(t.definition) + "</p>";
        rows.push(["Определение", t.definition]);
        if (t.explanation) rows.push(["Простыми словами", t.explanation]);
        if (t.why) rows.push(["Зачем тебе", t.why]);
        if (t.example) rows.push(["Пример", t.example]);
        if (t.pitfall) rows.push(["Частая ошибка", t.pitfall]);
        dl = '<dl class="explain">' + rows.map(function (r) {
          return "<dt>" + escapeHtml(r[0]) + "</dt><dd>" + escapeHtml(r[1]) + "</dd>";
        }).join("") + "</dl>";
      }
      html = '<div class="feedback bad"><h3>Ошибка</h3>' + head + dl + "</div>";
    }
    html += '<div class="next-row"><button class="btn" id="btn-next" type="button">Далее</button></div>';
    slot.innerHTML = html;
    var next = $("btn-next");
    next.addEventListener("click", nextCard);
    next.focus();
  }

  function finishSession() {
    var rec = {
      date: Date.now(),
      mode: session.mode,
      size: session.answered,
      correct: session.correct,
      byCategory: session.byCategory,
    };
    progress.sessions.push(rec);
    saveState();

    $("results-correct").textContent = session.correct;
    $("results-total").textContent = session.answered;
    var acc = session.answered ? Math.round((session.correct / session.answered) * 100) : 0;
    $("results-accuracy").textContent = acc + "%";

    var body = $("results-body");
    var html = "";
    if (session.mode === "exam") {
      html += "<h2 style='font-size:1rem'>Разбор ошибок экзамена</h2>";
      var misses = session.examLog.filter(function (e) { return !e.correct; });
      if (misses.length === 0) {
        html += "<p>Без ошибок.</p>";
      } else {
        misses.forEach(function (e) {
          var t = e.card.term, p = e.card.phrase;
          if (p) {
            html += "<p><b>" + escapeHtml(p.use) + "</b><br>" + escapeHtml(p.text) + "</p>";
          } else {
            html += "<p><b>" + escapeHtml(t.term) + "</b> — " + escapeHtml(t.definition);
            if (t.explanation) html += "<br><span class='note'>" + escapeHtml(t.explanation) + "</span>";
            html += "</p>";
          }
        });
      }
    }
    var cats = Object.keys(session.byCategory);
    if (cats.length) {
      html += "<table class='stats'><tr><th>Категория</th><th>Точность</th></tr>";
      cats.forEach(function (cid) {
        var c = session.byCategory[cid];
        var title = cid === "phrases" ? "Фразы" :
          (bank.categories.filter(function (x) { return x.id === cid; })[0] || {}).title || cid;
        var pct = Math.round((c.correct / c.total) * 100);
        html += "<tr><td>" + escapeHtml(title) + "</td><td>" +
          "<div class='meter'><div style='width:" + pct + "%'></div></div> " + c.correct + "/" + c.total + "</td></tr>";
      });
      html += "</table>";
    }
    body.innerHTML = html;
    showScreen("results");
  }

  // ---------- Главная и статистика ----------

  function streakDays() {
    var days = Object.keys(progress.daily).map(Number).sort(function (a, b) { return b - a; });
    if (!days.length) return 0;
    var today = dayIndex(Date.now());
    if (days[0] !== today && days[0] !== today - 1) return 0;
    var streak = 1;
    for (var i = 1; i < days.length; i++) {
      if (days[i] === days[i - 1] - 1) streak++;
      else break;
    }
    return streak;
  }

  function renderHome() {
    var now = Date.now();
    var learned = 0, due = 0, seenAny = 0;
    bank.terms.forEach(function (t) {
      var s = progress.terms[t.id];
      if (s) {
        if (s.box >= 3) learned++;
        if (s.seen) seenAny++;
        if (s.due <= now) due++;
      }
    });
    var day = String(dayIndex(now));
    var todayCount = progress.daily[day] || 0;
    $("home-strip").innerHTML =
      "<span class='chip'>Изучено <b>" + learned + "</b> / " + bank.terms.length + "</span>" +
      "<span class='chip'>К повторению <b>" + due + "</b></span>" +
      "<span class='chip'>Сегодня <b>" + todayCount + "</b> / " + settings.dailyGoal + "</span>" +
      "<span class='chip'>Серия <b>" + streakDays() + "</b> дн.</span>";

    document.querySelectorAll("[data-setting]").forEach(function (b) {
      var v = b.dataset.setting === "options" ? String(settings.options)
        : b.dataset.setting === "dailyGoal" ? String(settings.dailyGoal)
        : settings.direction;
      b.setAttribute("aria-pressed", String(b.value === v));
    });
  }

  function renderStats() {
    var now = Date.now();
    var html = "";
    var boxes = [0, 0, 0, 0, 0, 0];
    var seen = 0, correct = 0, wrong = 0;
    bank.terms.forEach(function (t) {
      var s = progress.terms[t.id];
      if (s && s.seen) {
        seen++; correct += s.correct; wrong += s.wrong;
        boxes[Math.min(boxes.length - 1, s.box)]++;
      }
    });
    html += "<div class='strip'><span class='chip'>В работе <b>" + seen + "</b> / " + bank.terms.length + "</span>" +
      "<span class='chip'>Верных <b>" + correct + "</b>, ошибок <b>" + wrong + "</b></span></div>";

    html += "<table class='stats'><tr><th>Ящик</th><th>Карточек</th></tr>";
    boxes.forEach(function (n, i) {
      html += "<tr><td>Ящик " + i + (i === 0 ? " (новые/ошибки)" : " · " + BOX_INTERVALS_DAYS[i] + " дн.") + "</td><td>" + n + "</td></tr>";
    });
    html += "</table>";

    // по категориям
    html += "<h2 style='font-size:1rem;margin-top:14px'>По категориям</h2>";
    html += "<table class='stats'><tr><th>Категория</th><th>Видно</th><th>Точность</th></tr>";
    bank.categories.forEach(function (c) {
      var s = 0, cor = 0, wrg = 0;
      bank.terms.forEach(function (t) {
        if (t.category !== c.id) return;
        var st = progress.terms[t.id];
        if (st && st.seen) { s++; cor += st.correct; wrg += st.wrong; }
      });
      var pct = (cor + wrg) ? Math.round(cor / (cor + wrg) * 100) : null;
      html += "<tr><td>" + escapeHtml(c.title) + "</td><td>" + s + "</td><td>" +
        (pct === null ? "—" : "<div class='meter'><div style='width:" + pct + "%'></div></div> " + pct + "%") + "</td></tr>";
    });
    html += "</table>";

    // 5 слабейших
    var weak = bank.terms.map(function (t) {
      var st = progress.terms[t.id];
      if (!st || !st.seen) return null;
      return { t: t, rate: st.wrong / st.seen, seen: st.seen };
    }).filter(Boolean).sort(function (a, b) { return b.rate - a.rate || b.seen - a.seen; }).slice(0, 5);
    if (weak.length) {
      html += "<h2 style='font-size:1rem;margin-top:14px'>Слабейшие термины</h2><ol class='weak-list'>";
      weak.forEach(function (w) {
        html += "<li><span class='mono'>" + escapeHtml(w.t.term) + "</span> — ошибок " +
          Math.round(w.rate * 100) + "% из " + w.seen + "</li>";
      });
      html += "</ol>";
    }

    // история
    var hist = progress.sessions.slice(-10).reverse();
    if (hist.length) {
      html += "<h2 style='font-size:1rem;margin-top:14px'>Последние сессии</h2>";
      html += "<table class='stats'><tr><th>Когда</th><th>Режим</th><th>Результат</th></tr>";
      hist.forEach(function (s) {
        html += "<tr><td>" + fmtDate(s.date) + "</td><td>" + (KIND_LABELS[s.mode] || s.mode) +
          "</td><td>" + s.correct + " / " + s.size + "</td></tr>";
      });
      html += "</table>";
    } else {
      html += "<p class='note' style='margin-top:12px'>Пока нет завершённых сессий.</p>";
    }
    $("stats-body").innerHTML = html;
  }

  // ---------- Навигация ----------

  function showScreen(name) {
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    var el = $("screen-" + name);
    if (el) el.classList.add("active");
    window.scrollTo(0, 0);
    if (name === "home") { session = null; renderHome(); }
    if (name === "stats") renderStats();
  }

  // ---------- Экспорт / импорт ----------

  function exportProgress() {
    var payload = {
      app: "vibe-quiz", version: 1, exportedAt: new Date().toISOString(),
      progress: progress,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    var d = new Date();
    a.download = "vibe-quiz-progress-" +
      d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function importProgress(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var payload = JSON.parse(reader.result);
        var p = payload.progress || payload;
        if (!p || !p.terms || !p.sessions) throw new Error("это не файл прогресса Вайб-квиза");
        progress = {
          terms: p.terms, sessions: p.sessions.slice(-SESSIONS_KEPT), daily: p.daily || {},
        };
        saveState();
        renderHome();
        alert("Прогресс импортирован.");
      } catch (e) {
        alert("Импорт не удался: " + (e && e.message ? e.message : e));
      }
    };
    reader.readAsText(file);
  }

  // ---------- События ----------

  function wireEvents() {
    document.querySelectorAll(".mode").forEach(function (b) {
      b.addEventListener("click", function () {
        var mode = b.dataset.mode;
        if (mode === "category") {
          var picker = $("category-picker");
          if (picker.style.display === "none") {
            picker.style.display = "";
            $("category-select").focus();
            return;
          }
          startSession("category", $("category-select").value);
          return;
        }
        startSession(mode, null);
      });
    });

    document.querySelectorAll("[data-setting]").forEach(function (b) {
      b.addEventListener("click", function () {
        var key = b.dataset.setting;
        var v = b.value;
        if (key === "options") settings.options = parseInt(v, 10);
        else if (key === "dailyGoal") settings.dailyGoal = parseInt(v, 10);
        else settings.direction = v;
        saveState();
        document.querySelectorAll("[data-setting='" + key + "']").forEach(function (x) {
          x.setAttribute("aria-pressed", String(x.value === v));
        });
        if (key === "dailyGoal") renderHome();
      });
    });

    document.querySelectorAll("[data-nav]").forEach(function (b) {
      b.addEventListener("click", function () {
        var to = b.dataset.nav;
        if (to === "export") exportProgress();
        else if (to === "import") $("import-file").click();
        else if (to === "again") startSession(session ? session.mode : "quick", session ? session.category : null);
        else if (to === "reset") {
          if (confirm("Сбросить весь прогресс? Действие нельзя отменить.")) {
            progress = { terms: {}, sessions: [], daily: {} };
            saveState();
            renderHome();
            showScreen("home");
          }
        }
        else showScreen(to);
      });
    });

    $("import-file").addEventListener("change", function () {
      if (this.files && this.files[0]) importProgress(this.files[0]);
      this.value = "";
    });

    document.addEventListener("keydown", function (e) {
      if (!$("screen-session").classList.contains("active")) return;
      if (e.key >= "1" && e.key <= "4") {
        var btns = document.querySelectorAll("#options .option");
        var i = parseInt(e.key, 10) - 1;
        if (btns[i] && !btns[i].disabled) btns[i].click();
      } else if (e.key === "Enter") {
        var next = $("btn-next");
        if (next) next.click();
      }
    });
  }

  // ---------- Запуск ----------

  function fillCategorySelect() {
    var sel = $("category-select");
    sel.innerHTML = "";
    bank.categories.forEach(function (c) {
      var n = bank.terms.filter(function (t) { return t.category === c.id; }).length;
      var opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.title + " (" + n + ")";
      sel.appendChild(opt);
    });
  }

  function registerSW() {
    if (window.VIBE_STANDALONE) return;  // автономный файл: офлайн и так гарантирован
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    navigator.serviceWorker.register("sw.js").catch(function () { /* офлайн не критичен */ });
  }

  initStorageDefensively();
  loadState();
  loadBank(function (b) {
    bank = b;
    fillCategorySelect();
    wireEvents();
    renderHome();
    registerSW();
  });
})();
