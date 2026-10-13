/* ==========================================================
   Pocket Ledger - app logic
   - Data, theme and currency are saved in browser cookies.
   - A single cookie holds ~4 KB, so expenses are split across
     several cookies (pl_0, pl_1, ...) and joined when loading.
   ========================================================== */

(() => {
  'use strict';

  /* ---------- Config ---------- */

  const CATEGORIES = [
    { id: 'food', label: 'Food' },
    { id: 'transport', label: 'Transport' },
    { id: 'housing', label: 'Housing' },
    { id: 'bills', label: 'Bills' },
    { id: 'shopping', label: 'Shopping' },
    { id: 'health', label: 'Health' },
    { id: 'fun', label: 'Fun' },
    { id: 'other', label: 'Other' },
  ];

  const CURRENCY_LOCALES = {
    INR: 'en-IN',
    USD: 'en-US',
    EUR: 'de-DE',
    GBP: 'en-GB',
    JPY: 'ja-JP',
  };

  const COOKIE_DAYS = 365;
  const CHUNK_SIZE = 3000; // characters of encoded data per cookie
  const MAX_CHUNKS = 40; // stays well under browser cookie-count limits

  const KEYS = {
    count: 'pl_n',
    chunk: (i) => `pl_${i}`,
    theme: 'pl_theme',
    currency: 'pl_currency',
  };

  /* ---------- Cookie helpers ---------- */

  const cookies = {
    set(name, value, days = COOKIE_DAYS) {
      const expires = new Date(Date.now() + days * 864e5).toUTCString();
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax${secure}`;
    },
    get(name) {
      const prefix = `${name}=`;
      for (const part of document.cookie.split('; ')) {
        if (part.startsWith(prefix)) return part.slice(prefix.length);
      }
      return null;
    },
    remove(name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
    },
    works() {
      try {
        cookies.set('pl_test', '1', 1);
        const ok = cookies.get('pl_test') === '1';
        cookies.remove('pl_test');
        return ok;
      } catch {
        return false;
      }
    },
  };

  // Split an already-encoded string without cutting a %XX escape in half.
  function splitEncoded(text, size) {
    const parts = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        if (text[end - 1] === '%') end -= 1;
        else if (text[end - 2] === '%') end -= 2;
      }
      parts.push(text.slice(start, end));
      start = end;
    }
    return parts;
  }

  const store = {
    saveExpenses(list) {
      // Short keys keep the cookies small.
      const compact = list.map((e) => ({ i: e.id, t: e.title, a: e.amount, c: e.category, d: e.date }));
      const encoded = encodeURIComponent(JSON.stringify(compact));
      const chunks = list.length ? splitEncoded(encoded, CHUNK_SIZE) : [];
      if (chunks.length > MAX_CHUNKS) return false;

      const previous = parseInt(cookies.get(KEYS.count), 10) || 0;
      chunks.forEach((chunk, i) => cookies.set(KEYS.chunk(i), chunk));
      for (let i = chunks.length; i < previous; i++) cookies.remove(KEYS.chunk(i));
      cookies.set(KEYS.count, String(chunks.length));

      // Read it back to make sure the browser really kept it.
      if (cookies.get(KEYS.count) !== String(chunks.length)) return false;
      return chunks.every((chunk, i) => cookies.get(KEYS.chunk(i)) === chunk);
    },

    loadExpenses() {
      try {
        const n = parseInt(cookies.get(KEYS.count), 10) || 0;
        if (!n) return [];
        let encoded = '';
        for (let i = 0; i < n; i++) encoded += cookies.get(KEYS.chunk(i)) || '';
        const data = JSON.parse(decodeURIComponent(encoded));
        if (!Array.isArray(data)) return [];

        const validCategories = new Set(CATEGORIES.map((c) => c.id));
        return data
          .filter(
            (e) =>
              e &&
              typeof e.t === 'string' &&
              Number.isFinite(e.a) &&
              e.a > 0 &&
              /^\d{4}-\d{2}-\d{2}$/.test(e.d)
          )
          .map((e) => ({
            id: String(e.i),
            title: e.t,
            amount: e.a,
            category: validCategories.has(e.c) ? e.c : 'other',
            date: e.d,
          }));
      } catch {
        return [];
      }
    },

    clearExpenses() {
      const n = parseInt(cookies.get(KEYS.count), 10) || 0;
      for (let i = 0; i < n; i++) cookies.remove(KEYS.chunk(i));
      cookies.remove(KEYS.count);
    },

    getSetting(key) {
      const value = cookies.get(key);
      if (value === null) return null;
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    },

    setSetting(key, value) {
      cookies.set(key, encodeURIComponent(value));
    },
  };

  /* ---------- DOM ---------- */

  const $ = (id) => document.getElementById(id);
  const els = {
    themeToggle: $('themeToggle'),
    currency: $('currency'),
    notice: $('notice'),
    noticeText: $('noticeText'),
    noticeClose: $('noticeClose'),
    periodLabel: $('periodLabel'),
    total: $('total'),
    bar: $('bar'),
    legend: $('legend'),
    count: $('count'),
    topCategory: $('topCategory'),
    form: $('expenseForm'),
    formTitle: $('formTitle'),
    title: $('title'),
    amount: $('amount'),
    date: $('date'),
    category: $('category'),
    titleError: $('titleError'),
    amountError: $('amountError'),
    dateError: $('dateError'),
    submitBtn: $('submitBtn'),
    cancelBtn: $('cancelBtn'),
    monthFilter: $('monthFilter'),
    allTimeBtn: $('allTimeBtn'),
    categoryFilter: $('categoryFilter'),
    list: $('list'),
    empty: $('empty'),
    clearAll: $('clearAll'),
    toast: $('toast'),
    toastText: $('toastText'),
    toastAction: $('toastAction'),
  };

  /* ---------- State ---------- */

  let expenses = [];
  let currency = 'INR';
  let editingId = null;
  let lastDeleted = null;
  let toastTimer = null;
  const filters = { month: '', category: 'all' };

  /* ---------- Small utilities ---------- */

  const pad = (n) => String(n).padStart(2, '0');

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatMoney(value) {
    const locale = CURRENCY_LOCALES[currency] || 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'JPY' ? 0 : 2,
    }).format(value);
  }

  function formatDate(iso) {
    const date = parseISO(iso);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  }

  function monthName(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  const categoryLabel = (id) => (CATEGORIES.find((c) => c.id === id) || CATEGORIES[7]).label;

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const ICON_EDIT =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
  const ICON_DELETE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  /* ---------- Notice + toast ---------- */

  function showNotice(message) {
    els.noticeText.textContent = message;
    els.notice.hidden = false;
  }

  function hideNotice() {
    els.notice.hidden = true;
  }

  function showToast(message, actionLabel, onAction) {
    clearTimeout(toastTimer);
    els.toastText.textContent = message;
    if (actionLabel) {
      els.toastAction.textContent = actionLabel;
      els.toastAction.hidden = false;
      els.toastAction.onclick = () => {
        hideToast();
        onAction();
      };
    } else {
      els.toastAction.hidden = true;
      els.toastAction.onclick = null;
    }
    els.toast.hidden = false;
    toastTimer = setTimeout(hideToast, 5000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    els.toast.hidden = true;
  }

  /* ---------- Persistence ---------- */

  let cookiesAvailable = true;

  function persist() {
    if (!cookiesAvailable) return;
    const ok = store.saveExpenses(expenses);
    if (!ok) {
      showNotice(
        'Your latest changes could not be saved to cookies. The cookie storage may be full or blocked. Delete older expenses to free up space.'
      );
    }
  }

  /* ---------- Theme ---------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0e1424' : '#eceee8');
    els.themeToggle.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
    );
  }

  function initTheme() {
    const saved = store.getSetting(KEYS.theme);
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved === 'dark' || saved === 'light' ? saved : systemDark ? 'dark' : 'light');
  }

  els.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.setSetting(KEYS.theme, next);
  });

  /* ---------- Rendering ---------- */

  function renderSummary() {
    const inPeriod = expenses.filter((e) => !filters.month || e.date.startsWith(filters.month));
    const total = inPeriod.reduce((sum, e) => sum + e.amount, 0);

    els.periodLabel.textContent = filters.month ? `Spent in ${monthName(filters.month)}` : 'Spent, all time';
    els.total.textContent = formatMoney(total);
    els.count.textContent = `${inPeriod.length} ${inPeriod.length === 1 ? 'entry' : 'entries'}`;

    const byCategory = CATEGORIES.map((c) => ({
      ...c,
      amount: inPeriod.filter((e) => e.category === c.id).reduce((s, e) => s + e.amount, 0),
    }))
      .filter((c) => c.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    els.topCategory.textContent = byCategory.length ? byCategory[0].label : 'None yet';

    els.bar.replaceChildren();
    els.legend.replaceChildren();

    byCategory.forEach((c) => {
      const seg = el('span');
      seg.style.flexGrow = c.amount;
      seg.style.background = `var(--c-${c.id})`;
      seg.title = `${c.label}: ${formatMoney(c.amount)}`;
      els.bar.appendChild(seg);

      const li = el('li');
      const swatch = el('span', 'swatch');
      swatch.style.background = `var(--c-${c.id})`;
      li.append(
        swatch,
        el('span', 'name', c.label),
        el('span', 'amt', formatMoney(c.amount)),
        el('span', 'pct', `${Math.round((c.amount / total) * 100)}%`)
      );
      els.legend.appendChild(li);
    });
  }

  function visibleExpenses() {
    return expenses
      .filter((e) => !filters.month || e.date.startsWith(filters.month))
      .filter((e) => filters.category === 'all' || e.category === filters.category)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  function buildRow(e) {
    const li = el('li', 'row');
    if (e.id === editingId) li.classList.add('is-editing');

    const dot = el('span', 'dot');
    dot.style.background = `var(--c-${e.category})`;

    const main = el('div');
    main.append(el('p', 'row-title', e.title), el('p', 'row-sub', `${categoryLabel(e.category)}, ${formatDate(e.date)}`));

    const amount = el('span', 'row-amount', formatMoney(e.amount));

    const actions = el('div', 'row-actions');
    const editBtn = el('button', 'icon-btn');
    editBtn.type = 'button';
    editBtn.innerHTML = ICON_EDIT;
    editBtn.setAttribute('aria-label', `Edit ${e.title}`);
    editBtn.addEventListener('click', () => startEdit(e.id));

    const delBtn = el('button', 'icon-btn delete');
    delBtn.type = 'button';
    delBtn.innerHTML = ICON_DELETE;
    delBtn.setAttribute('aria-label', `Delete ${e.title}`);
    delBtn.addEventListener('click', () => deleteExpense(e.id));

    actions.append(editBtn, delBtn);
    li.append(dot, main, amount, actions);
    return li;
  }

  function renderList() {
    const items = visibleExpenses();
    els.list.replaceChildren(...items.map(buildRow));

    if (items.length === 0) {
      els.empty.textContent = expenses.length
        ? 'Nothing matches these filters. Try another month or choose All time.'
        : 'No expenses yet. Add your first one using the form.';
      els.empty.hidden = false;
    } else {
      els.empty.hidden = true;
    }
  }

  function render() {
    renderSummary();
    renderList();
  }

  /* ---------- Form ---------- */

  function clearErrors() {
    [
      [els.title, els.titleError],
      [els.amount, els.amountError],
      [els.date, els.dateError],
    ].forEach(([input, error]) => {
      input.removeAttribute('aria-invalid');
      error.textContent = '';
    });
  }

  function setError(input, errorEl, message) {
    input.setAttribute('aria-invalid', 'true');
    errorEl.textContent = message;
  }

  function resetForm() {
    editingId = null;
    els.form.reset();
    els.date.value = todayISO();
    els.formTitle.textContent = 'Add expense';
    els.submitBtn.textContent = 'Add expense';
    els.cancelBtn.hidden = true;
    clearErrors();
  }

  function startEdit(id) {
    const item = expenses.find((e) => e.id === id);
    if (!item) return;
    editingId = id;
    els.title.value = item.title;
    els.amount.value = item.amount;
    els.date.value = item.date;
    els.category.value = item.category;
    els.formTitle.textContent = 'Edit expense';
    els.submitBtn.textContent = 'Save changes';
    els.cancelBtn.hidden = false;
    clearErrors();
    renderList();

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    els.form.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    els.title.focus({ preventScroll: true });
  }

  els.cancelBtn.addEventListener('click', () => {
    resetForm();
    renderList();
  });

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearErrors();

    const title = els.title.value.trim();
    const amount = parseFloat(els.amount.value);
    const date = els.date.value;
    const category = els.category.value;

    let valid = true;
    if (!title) {
      setError(els.title, els.titleError, 'Enter a name for this expense.');
      valid = false;
    }
    if (!(amount > 0) || amount > 1e9) {
      setError(els.amount, els.amountError, 'Enter an amount greater than 0.');
      valid = false;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError(els.date, els.dateError, 'Pick a date.');
      valid = false;
    }
    if (!valid) {
      const firstInvalid = els.form.querySelector('[aria-invalid="true"]');
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    const rounded = Math.round(amount * 100) / 100;
    const wasEditing = Boolean(editingId);

    if (wasEditing) {
      const item = expenses.find((e) => e.id === editingId);
      if (item) Object.assign(item, { title, amount: rounded, date, category });
    } else {
      expenses.unshift({ id: makeId(), title, amount: rounded, date, category });
    }

    // Make sure the saved expense isn't hidden by the current filters.
    if (filters.month && !date.startsWith(filters.month)) {
      filters.month = date.slice(0, 7);
      els.monthFilter.value = filters.month;
    }
    if (filters.category !== 'all' && filters.category !== category) {
      filters.category = 'all';
      els.categoryFilter.value = 'all';
    }

    persist();
    resetForm();
    render();
    showToast(wasEditing ? 'Changes saved' : 'Expense added');
    els.title.focus({ preventScroll: true });
  });

  /* ---------- Delete / clear ---------- */

  function deleteExpense(id) {
    const index = expenses.findIndex((e) => e.id === id);
    if (index === -1) return;
    const [item] = expenses.splice(index, 1);
    lastDeleted = { item, index };

    if (editingId === id) resetForm();
    persist();
    render();

    showToast(`Deleted "${item.title}"`, 'Undo', () => {
      if (!lastDeleted) return;
      expenses.splice(Math.min(lastDeleted.index, expenses.length), 0, lastDeleted.item);
      lastDeleted = null;
      persist();
      render();
    });
  }

  els.clearAll.addEventListener('click', () => {
    if (!expenses.length) {
      showToast('There is nothing to clear');
      return;
    }
    if (!confirm('Delete all expenses? This cannot be undone.')) return;
    expenses = [];
    lastDeleted = null;
    resetForm();
    if (cookiesAvailable) store.clearExpenses();
    render();
    showToast('All expenses deleted');
  });

  /* ---------- Filters + currency ---------- */

  els.monthFilter.addEventListener('change', () => {
    filters.month = els.monthFilter.value;
    render();
  });

  els.allTimeBtn.addEventListener('click', () => {
    filters.month = '';
    els.monthFilter.value = '';
    render();
  });

  els.categoryFilter.addEventListener('change', () => {
    filters.category = els.categoryFilter.value;
    renderList();
  });

  els.currency.addEventListener('change', () => {
    currency = els.currency.value;
    store.setSetting(KEYS.currency, currency);
    render();
  });

  els.noticeClose.addEventListener('click', hideNotice);

  /* ---------- Init ---------- */

  function init() {
    initTheme();

    // Fill category dropdowns
    CATEGORIES.forEach((c) => {
      els.category.appendChild(new Option(c.label, c.id));
    });
    els.categoryFilter.appendChild(new Option('All categories', 'all'));
    CATEGORIES.forEach((c) => {
      els.categoryFilter.appendChild(new Option(c.label, c.id));
    });

    // Cookies
    cookiesAvailable = cookies.works();
    if (cookiesAvailable) {
      expenses = store.loadExpenses();
      const savedCurrency = store.getSetting(KEYS.currency);
      if (savedCurrency && CURRENCY_LOCALES[savedCurrency]) currency = savedCurrency;
    } else {
      showNotice(
        'Cookies are unavailable, so your expenses will not be saved. If you opened index.html straight from your files, browsers like Chrome do not keep cookies for file:// pages. Run a local server instead, for example "python -m http.server" in this folder, then open http://localhost:8000.'
      );
    }

    els.currency.value = currency;

    const now = new Date();
    filters.month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    els.monthFilter.value = filters.month;

    els.date.value = todayISO();
    render();
  }

  init();
})();
