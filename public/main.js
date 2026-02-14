// ================= Loader helpers =================
var loaderEl = document.getElementById('loader');
var loaderFill = document.getElementById('loader-bar-fill');
var loaderPercent = document.getElementById('loader-percent');
var loaderStep = document.getElementById('loader-step');
var loaderSubtitle = document.getElementById('loader-subtitle');
var appEl = document.getElementById('app');

var totalTasks = 0;
var doneTasks = 0;

function setLoaderStep(text) { loaderStep.textContent = text; }
function setLoaderSubtitle(text) { loaderSubtitle.textContent = text; }

function registerTask(label) {
  totalTasks++;
  setLoaderStep(label);
  updateProgress();
  var finished = false;
  return function finish() {
    if (finished) return;
    finished = true;
    doneTasks++;
    updateProgress();
  };
}

function updateProgress() {
  var p = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100);
  loaderFill.style.width = p + '%';
  loaderPercent.textContent = p + '%';
}

function showApp() {
  loaderEl.classList.add('hidden');
  appEl.classList.remove('app-hidden');
  appEl.classList.add('app-ready');
}

// ================= Telegram =================
var tg = window.Telegram ? window.Telegram.WebApp : null;
var userId = 'test_user';
var tgUsername = '';
var spinPrice = 1;

if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('#0d0d0f'); } catch(e){ console.error("Error setting header color:", e); }
  try { tg.setBackgroundColor('#0d0d0f'); } catch(e){ console.error("Error setting background color:", e); }
  if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
    userId = tg.initDataUnsafe.user.id.toString();
    tgUsername = tg.initDataUnsafe.user.username || '';
  }
}

// ================= Config + prizes =================
// Порядок = порядок секторов, должен совпадать с wheelSectors на сервере
var PRIZES = [
  { id:'prize_1', name:'Медведь', image:'/img/prize1.png', color:'#27272a' },
  { id:'prize_2', name:'Роза',    image:'/img/prize2.png', color:'#292524' },
  { id:'prize_3', name:'Леденец', image:'/img/prize3.png', color:'#172554' },
  { id:'prize_4', name:'Сига',    image:'/img/prize4.png', color:'#2e1065' },
  { id:'prize_5', name:'Папаха',  image:'/img/prize5.png', color:'#3a2600' },
  { id:'prize_6', name:'Кнопка',  image:'/img/prize6.png', color:'#1f2937' }
];

var NUM = PRIZES.length;
var ARC = (2 * Math.PI) / NUM;

// ================= Preload =================
function preloadImage(url) {
  return new Promise(function(resolve) {
    var img = new Image();
    img.onload = function() { resolve({ ok: true, img: img }); };
    img.onerror = function() { resolve({ ok: false, img: null }); };
    img.src = url;
  });
}

var loadedImages = {}; // by prize id

function preloadAllAssets() {
  var tasks = [];

  // Config
  var finishCfg = registerTask('config');
  setLoaderSubtitle('Загружаем настройки…');
  tasks.push(
    fetch('/api/config')
      .then(function(r){ return r.json(); })
      .then(function(cfg){
        spinPrice = cfg.spinPrice || 1;
        var priceEl = document.getElementById('spin-price');
        if (priceEl) priceEl.textContent = spinPrice + ' Star' + (spinPrice > 1 ? 's' : '');
      })
      .catch(function(){})
      .finally(function(){ finishCfg(); })
  );

  // Images
  setLoaderSubtitle('Подгружаем картинки…');
  for (var i = 0; i < PRIZES.length; i++) {
    (function(idx){
      var finishImg = registerTask('images');
      tasks.push(
        preloadImage(PRIZES[idx].image).then(function(r){
          if (r.ok && r.img) loadedImages[PRIZES[idx].id] = r.img;
        }).finally(function(){ finishImg(); })
      );
    })(i);
  }

  // DOM
  var finishDom = registerTask('dom');
  tasks.push(
    new Promise(function(resolve){
      if (document.readyState === 'complete' || document.readyState === 'interactive') resolve();
      else document.addEventListener('DOMContentLoaded', function(){ resolve(); }, { once: true });
    }).finally(function(){ finishDom(); })
  );

  return Promise.all(tasks);
}

// ================= UI render =================
function renderPrizesGrid() {
  var list = document.getElementById('prizes-list');
  list.innerHTML = '';
  for (var i = 0; i < PRIZES.length; i++) {
    var p = PRIZES[i];
    var card = document.createElement('div');
    card.className = 'prize-card';
    card.innerHTML =
      '<div class="prize-card-icon"><img src="' + p.image + '" alt=""></div>' +
      '<div class="prize-card-name">' + p.name + '</div>';
    list.appendChild(card);
  }
}

function findPrize(id) {
  for (var i = 0; i < PRIZES.length; i++) if (PRIZES[i].id === id) return PRIZES[i];
  return null;
}

// ================= Canvas / wheel =================
var canvas = document.getElementById('wheel-canvas');
var ctx = canvas.getContext('2d');

var CSS_SIZE = 320;
var dpr = window.devicePixelRatio || 1;

canvas.width = CSS_SIZE * dpr;
canvas.height = CSS_SIZE * dpr;
canvas.style.width = CSS_SIZE + 'px';
canvas.style.height = CSS_SIZE + 'px';
ctx.scale(dpr, dpr);

var CX = CSS_SIZE / 2;
var CY = CSS_SIZE / 2;
var R = CSS_SIZE / 2 - 4;

var currentAngle = 0;
var spinning = false;

// idle (очень медленно)
var idleSpinning = false;
var idleSpeed = 0.0008; // ~1 оборот ~ 130 сек
var idleRaf = null;

function startIdleSpin() {
  if (idleSpinning || spinning) return;
  idleSpinning = true;

  function frame() {
    if (!idleSpinning) return;
    currentAngle += idleSpeed;
    drawWheel(currentAngle);
    idleRaf = requestAnimationFrame(frame);
  }
  idleRaf = requestAnimationFrame(frame);
}

function stopIdleSpin() {
  idleSpinning = false;
  if (idleRaf) {
    cancelAnimationFrame(idleRaf);
    idleRaf = null;
  }
}

function lighten(h, a) {
  var n = parseInt(h.replace('#', ''), 16);
  return 'rgb(' +
    Math.min(255, (n >> 16) + a) + ',' +
    Math.min(255, ((n >> 8) & 0xff) + a) + ',' +
    Math.min(255, (n & 0xff) + a) + ')';
}
function darken(h, a) {
  var n = parseInt(h.replace('#', ''), 16);
  return 'rgb(' +
    Math.max(0, (n >> 16) - a) + ',' +
    Math.max(0, ((n >> 8) & 0xff) - a) + ',' +
    Math.max(0, (n & 0xff) - a) + ')';
}

function drawWheel(angle) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CSS_SIZE, CSS_SIZE);

  ctx.save();
  ctx.translate(CX, CY);
  ctx.rotate(angle);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (var i = 0; i < NUM; i++) {
    var start = i * ARC - Math.PI / 2;
    var end = start + ARC;
    var mid = start + ARC / 2;
    var p = PRIZES[i];

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, start, end);
    ctx.closePath();

    var g = ctx.createRadialGradient(0, 0, 10, 0, 0, R);
    g.addColorStop(0, lighten(p.color, 15));
    g.addColorStop(0.6, p.color);
    g.addColorStop(1, darken(p.color, 10));
    ctx.fillStyle = g;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(start) * R, Math.sin(start) * R);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.save();
    ctx.rotate(mid);

    var img = loadedImages[p.id];
    if (img) {
      var s = 46;
      ctx.save();
      ctx.translate(R * 0.52, 0);
      ctx.rotate(-mid - angle); // upright
      ctx.drawImage(img, -s / 2, -s / 2, s, s);
      ctx.restore();
    }

    ctx.restore();
  }

  var la = (NUM - 1) * ARC - Math.PI / 2 + ARC;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(la) * R, Math.sin(la) * R);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fillStyle = '#0d0d0f';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  var cg = ctx.createRadialGradient(0, 0, 0, 0, 0, 15);
  cg.addColorStop(0, '#a78bfa');
  cg.addColorStop(1, '#6d28d9');
  ctx.fillStyle = cg;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

// стоп строго в центр нужного сегмента
function animateSpin(segIdx) {
  return new Promise(function(resolve) {
    var DUR = 4000;
    var FULL = 6; // полных оборотов

    var desired = (2 * Math.PI - (segIdx + 0.5) * ARC);
    desired = ((desired % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);

    var currentNorm = ((currentAngle % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
    var delta = desired - currentNorm;
    if (delta < 0) delta += 2 * Math.PI;

    var totalDelta = FULL * 2 * Math.PI + delta;

    var startA = currentAngle;
    var startT = performance.now();
    var lastTick = 0;

    function ease(t) { return 1 - Math.pow(1 - t, 4); }

    function frame(now) {
      var p = Math.min((now - startT) / DUR, 1);

      if (p < 1) {
        currentAngle = startA + totalDelta * ease(p);
        drawWheel(currentAngle);

        if (tg && p < 0.85) {
          var tick = Math.floor((currentAngle - startA) / ARC);
          if (tick !== lastTick) {
            lastTick = tick;
            try { tg.HapticFeedback.selectionChanged(); } catch(e){}
          }
        }

        requestAnimationFrame(frame);
      } else {
        currentAngle = startA + totalDelta;
        drawWheel(currentAngle);
        resolve();
      }
    }

    requestAnimationFrame(frame);
  });
}

// ================= Spin payment flow =================
var spinBtn = document.getElementById('spin-btn');
var currentSpinKey = null;

spinBtn.addEventListener('click', function() {
  if (spinning) return;
  if (!tg) { alert('Оплата работает только в Telegram'); return; }

  spinning = true;
  spinBtn.disabled = true;
  stopIdleSpin();
  spinBtn.querySelector('.spin-btn-text').textContent = '⏳ Оплата...';

  fetch('/api/create-invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: userId })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (!data.invoiceUrl) throw new Error('No invoiceUrl');
      currentSpinKey = data.spinKey;
      console.log('Frontend: SpinKey generated:', currentSpinKey);
      tg.openInvoice(data.invoiceUrl, function(status) {
        if (status === 'paid') {
          spinBtn.querySelector('.spin-btn-text').textContent = '🌀 Крутится...';
          waitAndSpin(currentSpinKey, 0);
        } else {
          resetSpinBtn();
        }
      });
    })
    .catch(function(err){
      console.error('Error creating invoice:', err);
      alert('Ошибка создания инвойса. Проверьте консоль.');
      resetSpinBtn();
    });
});

function waitAndSpin(key, attempt) {
  // Увеличиваем лимит попыток на случай экстремальных задержек
  if (attempt > 40) { // 40 попыток * 750ms = 30 секунд ожидания
    console.error('Frontend: Exceeded maximum attempts to confirm payment and spin result.');
    alert('Не удалось подтвердить платёж. Пожалуйста, проверьте инвентарь или попробуйте еще раз.');
    resetSpinBtn();
    return;
  }

  // Добавляем начальную задержку 1.5 секунды перед первым запросом
  // (только если это первая попытка)
  if (attempt === 0) {
    console.log('Frontend: Initial delay before first /api/spin request...');
    setTimeout(function() { waitAndSpin(key, attempt + 1); }, 1500);
    return;
  }

  console.log(`Frontend: Attempt ${attempt} to get spin result for key: ${key}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // Таймаут 25 секунд на один запрос

  fetch('/api/spin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: userId, spinKey: key }),
    signal: controller.signal
  })
    .then(function(response){
      clearTimeout(timeoutId); // Очищаем таймаут после получения ответа

      // Если запрос был отменен (e.g. сеть потеряна или явный abort)
      if (!response.ok && response.status === 0) { // fetch might return status 0 for aborted
        console.warn('Frontend: /api/spin request aborted (status 0), retrying...');
        setTimeout(function(){ waitAndSpin(key, attempt + 1); }, 1000); // Более быстрый повтор после AbortError
        return null;
      }

      // Обработка 402 "not paid yet"
      if (response.status === 402) {
        console.log('Frontend: /api/spin returned 402 (payment not confirmed yet), retrying...');
        setTimeout(function(){ waitAndSpin(key, attempt + 1); }, 750);
        return null; // Важно, чтобы дальше не шло
      }

      // Если пришел любой другой неуспешный статус (например 500)
      if (!response.ok) {
        console.error('Frontend: /api/spin returned error status:', response.status);
        alert('Ошибка сервера при прокрутке. Пожалуйста, попробуйте позже.');
        resetSpinBtn(); // Выходим из цикла, т.к. возможно ошибка постоянная
        throw new Error('Server error: ' + response.status); // Бросаем ошибку для дальнейшего catch
      }

      // Если успешно (200 OK)
      return response.json();
    })
    .then(function(data){
      if (!data) return; // Пропускаем, если data === null (был 402 или AbortError)

      console.log('Frontend: /api/spin successful, received data:', data);
      return animateSpin(data.segmentIndex).then(function(){ return data; });
    })
    .then(function(data){
      if (!data) return;
      console.log('Frontend: Spin animation finished, prize:', data.prize);
      try { tg.HapticFeedback.notificationOccurred('success'); } catch(e){}
      showResult(data.prize);
      resetSpinBtn();
    })
    .catch(function(err){
      clearTimeout(timeoutId); // Очищаем таймаут и при ошибке

      if (err.name === 'AbortError') {
          console.warn('Frontend: /api/spin request timed out or aborted, retrying...');
          setTimeout(function(){ waitAndSpin(key, attempt + 1); }, 1000); // Более быстрый повтор
      } else {
          console.error('Frontend: Unhandled fetch error for /api/spin:', err);
          alert('Произошла непредвиденная ошибка. Пожалуйста, попробуйте снова.');
          resetSpinBtn(); // Выходим из цикла, чтобы не спамить запросами при постоянной ошибке
      }
    });
}

function resetSpinBtn() {
  spinning = false;
  spinBtn.disabled = false;
  spinBtn.querySelector('.spin-btn-text').textContent = '⭐ Крутить';
  currentSpinKey = null;
  startIdleSpin();
}

// ================= Result popup =================
function showResult(prize) {
  var popup = document.getElementById('result-popup');
  var gc = document.getElementById('result-img-container'); // Название контейнера
  var nameEl = document.getElementById('result-name');
  var closeBtn = document.getElementById('result-close');

  // --- ДОБАВЛЕННЫЕ ПРОВЕРКИ ---
  if (!popup) { console.error("Frontend ERROR: Element with ID 'result-popup' not found!"); alert('Ошибка: Базовый попап не найден.'); return; }
  if (!gc) { console.error("Frontend ERROR: Element with ID 'result-img-container' not found!"); alert('Ошибка: Контейнер картинки не найден.'); return; }
  if (!nameEl) { console.error("Frontend ERROR: Element with ID 'result-name' not found!"); alert('Ошибка: Элемент названия приза не найден.'); return; }
  if (!closeBtn) { console.error("Frontend ERROR: Element with ID 'result-close' not found!"); alert('Ошибка: Кнопка закрытия не найдена.'); return; }
  // --- КОНЕЦ ПРОВЕРОК ---

  var pd = findPrize(prize.id); // Получаем данные приза из PRIZES массива

  // Отображаем изображение
  if (pd && pd.image) {
    gc.innerHTML = '<img src="' + pd.image + '" alt="' + pd.name + '">';
  } else {
    // Фоллбэк, если image по какой-то причине нет
    gc.innerHTML = '🎁';
  }

  nameEl.textContent = prize.name; // Устанавливаем название приза

  popup.classList.remove('hidden'); // Показываем попап
}

document.getElementById('result-close').addEventListener('click', function() {
  document.getElementById('result-popup').classList.add('hidden');
  var gc = document.getElementById('result-img-container');
  if (gc) gc.innerHTML = ''; // Очищаем контейнер, если найден
});

// ================= Tabs =================
document.querySelectorAll('.tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
    document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });

    tab.classList.add('active');
    var target = tab.getAttribute('data-tab');
    document.getElementById(target + '-screen').classList.add('active');

    if (target === 'inventory') loadInventory();
  });
});

// ================= Withdraw + inventory =================
var withdrawModal = document.getElementById('withdraw-modal');
var withdrawInput = document.getElementById('withdraw-username');
var formError = document.getElementById('form-error');
var submitBtn = document.getElementById('modal-submit-btn');
var currentWithdrawItem = null;

function openWithdrawModal(item) {
  currentWithdrawItem = item;
  var pd = findPrize(item.id);
  var iconEl = document.getElementById('modal-prize-icon');

  if (pd && pd.image) iconEl.innerHTML = '<img src="' + pd.image + '" alt="">';
  else iconEl.textContent = '🎁';

  document.getElementById('modal-prize-name').textContent = item.name;

  // Если был элемент для редкости, он удален или не используется
  // var rarityEl = document.getElementById('modal-prize-rarity');
  // if (rarityEl) { rarityEl.textContent = ''; }

  withdrawInput.value = tgUsername;
  formError.classList.add('hidden');
  submitBtn.disabled = false;
  submitBtn.textContent = '📤 Отправить заявку';

  withdrawModal.classList.remove('hidden');
  setTimeout(function(){ withdrawInput.focus(); }, 350);
}

function closeWithdrawModal() {
  withdrawModal.classList.add('hidden');
  currentWithdrawItem = null;
}

document.getElementById('modal-close-btn').addEventListener('click', closeWithdrawModal);
document.getElementById('withdraw-overlay').addEventListener('click', closeWithdrawModal);

submitBtn.addEventListener('click', function() {
  var username = withdrawInput.value.trim().replace(/^@/, '');
  if (!username) {
    formError.classList.remove('hidden');
    withdrawInput.focus();
    return;
  }

  formError.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ Отправляем...';

  fetch('/api/withdraw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: userId, itemUid: currentWithdrawItem.uid, username: username })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.success) {
        try { tg.HapticFeedback.notificationOccurred('success'); } catch(e){}
        closeWithdrawModal();
        showSuccessToast(currentWithdrawItem);
        loadInventory();
      } else {
        formError.textContent = data.error || 'Ошибка';
        formError.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = '📤 Отправить заявку';
      }
    })
    .catch(function(err){
      console.error('Error on withdraw API call:', err);
      formError.textContent = 'Ошибка сети';
      formError.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = '📤 Отправить заявку';
    });
});

withdrawInput.addEventListener('input', function() {
  formError.classList.add('hidden');
});

var successToast = document.getElementById('success-toast');
var successTimer = null;

function showSuccessToast(item) {
  var pd = findPrize(item.id);
  var icon = (pd && pd.image)
    ? '<img src="' + pd.image + '" style="width:20px;height:20px;vertical-align:middle"> '
    : '';
  document.getElementById('success-toast-prize').innerHTML = icon + item.name;

  successToast.classList.remove('hidden');
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(closeSuccessToast, 5000);
}

function closeSuccessToast() {
  successToast.classList.add('hidden');
  if (successTimer) { clearTimeout(successTimer); successTimer = null; }
}

document.getElementById('success-toast-btn').addEventListener('click', closeSuccessToast);
document.getElementById('success-overlay').addEventListener('click', closeSuccessToast);

function loadInventory() {
  var list = document.getElementById('inventory-list');
  list.innerHTML = '<p class="empty-text">Загрузка...</p>';

  fetch('/api/inventory/' + userId)
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (!data.inventory || data.inventory.length === 0) {
        list.innerHTML = '<p class="empty-text">Пока пусто — крути барабан!</p>';
        return;
      }

      list.innerHTML = '';

      var sl = {
        inventory: null,
        pending: { text: '⏳ Ожидание', cls: 'pending' },
        completed: { text: '✅ Успешно', cls: 'completed' },
        rejected: { text: '❌ Отказано', cls: 'rejected' }
      };

      var items = data.inventory.slice().reverse();
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var pd = findPrize(item.id);

        var iconHtml = (pd && pd.image)
          ? '<div class="inv-icon"><img src="' + pd.image + '" alt=""></div>'
          : '<div class="inv-icon">🎁</div>';

        var status = item.status || 'inventory';
        var actionHtml;

        if (status === 'inventory') {
          actionHtml = '<button class="withdraw-btn">📤 Вывести</button>';
        } else {
          var s = sl[status];
          actionHtml = '<div class="status-badge ' + s.cls + '">' + s.text + '</div>';
        }

        var el = document.createElement('div');
        el.className = 'inventory-item';
        el.innerHTML =
          iconHtml +
          '<div class="inv-info"><div class="inv-name">' + item.name + '</div></div>' +
          actionHtml;

        list.appendChild(el);

        if (status === 'inventory') {
          var btn = el.querySelector('.withdraw-btn');
          btn._itemData = item;
          btn.addEventListener('click', function() {
            openWithdrawModal(this._itemData);
          });
        }
      }
    })
    .catch(function(err){
      console.error('Error on inventory API call:', err);
      list.innerHTML = '<p class="empty-text">Ошибка загрузки 😔</p>';
    });
}

// ================= Boot =================
(async function boot() {
  setLoaderSubtitle('Подготавливаем мини‑апп…');
  updateProgress();

  // первичная отрисовка
  drawWheel(0);

  await preloadAllAssets();

  setLoaderSubtitle('Готово!');
  renderPrizesGrid();
  drawWheel(currentAngle);

  setTimeout(function() {
    showApp();
    startIdleSpin();
  }, 250);
})();