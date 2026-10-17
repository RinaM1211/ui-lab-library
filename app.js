// ============================================================
//  Library Booking — Supabase auth + bookings + users
// ============================================================

const ROLE_LABELS = {
  reader:    'Читатель',
  librarian: 'Библиотекарь',
  manager:   'Менеджер',
};

const ROLES = {
  reader:    { canSeeAll: false },
  librarian: { canSeeAll: true  },
  manager:   { canSeeAll: true  },
};

const STATUS_LABELS = {
  pending:   'Ожидает',
  approved:  'Подтверждена',
  issued:    'Выдана',
  returned:  'Возвращена',
  cancelled: 'Отменена',
};

let state = {
  sb: null,          // supabase client
  user: null,        // текущий auth-пользователь
  profile: null,     // { id, full_name, role }
  filter: 'all',
  bookings: [],
};

// ====== Утилиты ======
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

const role       = () => state.profile?.role ?? 'reader';
const roleInfo   = () => ROLES[role()] ?? ROLES.reader;
const userName   = () => state.profile?.full_name ?? state.user?.email ?? 'Гость';

function showPage(id) {
  $$('.page').forEach(p => p.hidden = p.id !== id);
}

// ====== Права ======
function can(booking, action) {
  const r = role();
  const isOwn = booking.user_id === state.user?.id;

  if (r === 'reader') {
    if (action === 'cancel') return isOwn && ['pending','approved'].includes(booking.status);
    return false;
  }
  if (r === 'librarian') {
    if (action === 'approve') return booking.status === 'pending';
    if (action === 'issue')   return booking.status === 'approved';
    if (action === 'return')  return booking.status === 'issued';
    return false;
  }
  if (r === 'manager') {
    return ['approve','issue','return','cancel','delete'].includes(action);
  }
  return false;
}

// ====== Загрузка профиля ======
async function loadProfile(userId) {
  const { data, error } = await state.sb
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.warn('Не удалось загрузить профиль:', error.message);
  }

  if (data) {
    state.profile = data;
    return;
  }

  // Если профиля нет — создаём его на основе метаданных auth.users
  const meta = state.user.user_metadata ?? {};
  const newProfile = {
    id: userId,
    full_name: meta.full_name ?? state.user.email,
    role: meta.role ?? 'reader',
  };
  const { data: created, error: insErr } = await state.sb
    .from('profiles')
    .insert(newProfile)
    .select()
    .single();

  if (insErr) {
    console.warn('Не удалось создать профиль:', insErr.message);
    state.profile = newProfile; // fallback
  } else {
    state.profile = created;
  }
}

// ====== Список броней ======
async function renderList() {
  const info = roleInfo();
  const isReader = role() === 'reader';

  $('#listTitle').textContent    = info.canSeeAll ? 'Все брони' : 'Мои брони';
  $('#listSubtitle').textContent = info.canSeeAll
    ? 'Управление бронями читателей.'
    : 'Ваши созданные брони.';
  $('#openCreateButton').hidden = !isReader;
  $('#statusFilter').hidden     = !info.canSeeAll;

  const container = $('#bookingList');
  container.innerHTML = '<div class="empty">Загрузка...</div>';

  let query = state.sb.from('bookings').select('*');
  if (!info.canSeeAll) query = query.eq('user_id', state.user.id);
  if (state.filter !== 'all') query = query.eq('status', state.filter);
  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) {
    container.innerHTML = `<div class="empty">Ошибка: ${error.message}</div>`;
    return;
  }

  state.bookings = data ?? [];

  if (!state.bookings.length) {
    container.innerHTML = `<div class="empty">Броней нет</div>`;
    return;
  }

  container.innerHTML = state.bookings.map(b => `
    <div class="card" data-id="${b.id}">
      <div class="card-head">
        <div>
          <div class="card-title">${b.book_title}</div>
          <div class="card-sub">${b.book_author} · ${b.book_isbn ?? ''}</div>
        </div>
        <span class="badge badge-${b.status}">${STATUS_LABELS[b.status]}</span>
      </div>
      <div class="card-body">
        <div>Читатель: <b>${b.user_name}</b></div>
        <div>Дата выдачи: <b>${b.pickup_date}</b></div>
        ${b.comment ? `<div>Комментарий: ${b.comment}</div>` : ''}
      </div>
      <div class="actions-row">
        ${renderActions(b)}
        <button class="button button-secondary" data-action="open" data-id="${b.id}">Подробнее</button>
      </div>
    </div>
  `).join('');
}

function renderActions(b) {
  const btns = [];
  if (can(b, 'approve'))
    btns.push(`<button class="button button-primary" data-action="approve" data-id="${b.id}">Подтвердить</button>`);
  if (can(b, 'issue'))
    btns.push(`<button class="button button-primary" data-action="issue" data-id="${b.id}">Выдать</button>`);
  if (can(b, 'return'))
    btns.push(`<button class="button button-primary" data-action="return" data-id="${b.id}">Вернуть</button>`);
  if (can(b, 'cancel'))
    btns.push(`<button class="button button-secondary" data-action="cancel" data-id="${b.id}">Отменить</button>`);
  if (can(b, 'delete'))
    btns.push(`<button class="button button-secondary" data-action="delete" data-id="${b.id}">Удалить</button>`);
  return btns.join('');
}

// ====== Детали ======
function renderDetail(id) {
  const b = state.bookings.find(x => x.id === id);
  if (!b) return showPage('listPage');

  $('#bookingDetails').innerHTML = `
    <h1>${b.book_title}</h1>
    <p>${b.book_author} · ISBN ${b.book_isbn ?? '—'}</p>
    <div class="card">
      <div>Статус: <span class="badge badge-${b.status}">${STATUS_LABELS[b.status]}</span></div>
      <div>Читатель: <b>${b.user_name}</b></div>
      <div>Дата выдачи: <b>${b.pickup_date}</b></div>
      <div>Создана: <b>${new Date(b.created_at).toISOString().slice(0,10)}</b></div>
      ${b.comment ? `<div>Комментарий: ${b.comment}</div>` : ''}
    </div>
    <div class="actions-row">${renderActions(b)}</div>
  `;
  showPage('detailPage');
}

// ====== Действия ======
async function applyAction(action, id) {
  const messages = {
    approve: 'Бронь подтверждена',
    issue:   'Книга выдана',
    return:  'Книга возвращена',
    cancel:  'Бронь отменена',
    delete:  'Бронь удалена',
  };
  let error;

  if (action === 'delete') {
    ({ error } = await state.sb.from('bookings').delete().eq('id', id));
  } else {
    const map = { approve: 'approved', issue: 'issued', return: 'returned', cancel: 'cancelled' };
    ({ error } = await state.sb.from('bookings').update({ status: map[action] }).eq('id', id));
  }

  if (error) { toast('Ошибка: ' + error.message); return; }
  toast(messages[action] || 'Готово');
  await renderList();
  if (!$('#detailPage').hidden) showPage('listPage');
}

// ====== Создание ======
async function handleCreate(e) {
  e.preventDefault();
  const form = e.target;
  const bookVal = form.book.value;
  const pickupDate = form.pickupDate.value;
  const comment = form.comment.value.trim();

  let ok = true;
  $('#bookError').textContent = '';
  $('#pickupDateError').textContent = '';
  if (!bookVal)    { $('#bookError').textContent = 'Выберите книгу'; ok = false; }
  if (!pickupDate) { $('#pickupDateError').textContent = 'Укажите дату'; ok = false; }
  if (!ok) return;

  const [book_title, book_author, book_isbn] = bookVal.split('|');

  const { error } = await state.sb.from('bookings').insert({
    user_id:     state.user.id,
    user_name:   userName(),
    book_title, book_author, book_isbn,
    pickup_date: pickupDate,
    comment:     comment || null,
    status:      'pending',
  });

  if (error) { toast('Ошибка: ' + error.message); return; }

  form.reset();
  toast('Бронь создана');
  showPage('listPage');
  await renderList();
}

// ====== Пользователи ======
async function renderUsers() {
  const container = $('#usersList');
  container.innerHTML = '<div class="empty">Загрузка...</div>';

  const { data, error } = await state.sb
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    container.innerHTML = `<div class="empty">Ошибка: ${error.message}</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = `<div class="empty">Пользователей нет</div>`;
    return;
  }

  container.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>Имя</th>
          <th>Роль</th>
          <th>Создан</th>
        </tr>
      </thead>
      <tbody>
        ${data.map(u => `
          <tr>
            <td>${u.full_name ?? '—'}</td>
            <td><span class="role-badge ${u.role}">${ROLE_LABELS[u.role] ?? u.role}</span></td>
            <td>${u.created_at ? new Date(u.created_at).toISOString().slice(0,10) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// ====== Инициализация ======
async function init() {
  if (!window.supabase) {
    await new Promise(res => window.addEventListener('supabase-ready', res, { once: true }));
  }
  state.sb = window.supabase;

  // Проверяем сессию
  const { data: { session } } = await state.sb.auth.getSession();
  if (!session) {
    window.location.href = 'auth.html';
    return;
  }
  state.user = session.user;
  await loadProfile(state.user.id);

  // Шапка
  $('#userName').textContent = userName();
  $('#userRole').textContent = ROLE_LABELS[role()] ?? '';
  $('#usersButton').hidden = role() !== 'manager';

  // Выход
  $('#logoutButton').addEventListener('click', async () => {
    await state.sb.auth.signOut();
    window.location.href = 'auth.html';
  });

  // Кнопка "Пользователи"
  $('#usersButton').addEventListener('click', () => {
    showPage('usersPage');
    renderUsers();
  });

  // data-page
  $$('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (!page) return;
      showPage(page);
      if (page === 'listPage') renderList();
    });
  });

  // Создать бронь
  $('#openCreateButton').addEventListener('click', () => {
    if (role() !== 'reader') { toast('Создавать брони может только читатель'); return; }
    showPage('createPage');
  });

  // Форма
  $('#bookingForm').addEventListener('submit', handleCreate);

  // Фильтры
  $('#statusFilter').addEventListener('click', async (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    $$('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.status;
    await renderList();
  });

  // Действия в карточках
  document.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'open') return renderDetail(id);
    await applyAction(action, id);
  });

  // Обновление при истечении сессии
  state.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.href = 'auth.html';
  });

  await renderList();
}

document.addEventListener('DOMContentLoaded', init);