import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'simple_memo';
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: '자동', light: '라이트', dark: '다크' };
const MOBILE_MAX_WIDTH = 600;
const EDGE = 8;
const NOTICE_MS = 1300;
const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DRAFT_KEY = 'st_memo_draft';

const defaultSettings = {
    notes: [],
    trash: [],
    theme: 'auto',
    keepSizeWithKeyboard: false,
    panel: {
        open: false,
        left: null,
        top: null,
        width: 440,
        height: 600,
    },
};

// 저장되지 않는 화면 상태.
let view = 'list';
let draft = null;
let searchQuery = '';
let selecting = false;
const selected = new Set();
let trashSelecting = false;
const selectedTrash = new Set();
let statusTimer = null;
let noticeTimer = null;
let draftTimer = null;
let dialogOpen = false;
let draftChecked = false;
let mobileGeometry = null;

function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extension_settings[MODULE_NAME];
    if (typeof settings.keepSizeWithKeyboard !== 'boolean') {
        settings.keepSizeWithKeyboard = false;
    }

    if (!Array.isArray(settings.notes)) {
        settings.notes = [];
    }
    if (!Array.isArray(settings.trash)) {
        settings.trash = [];
    }
    if (!THEMES.includes(settings.theme)) {
        settings.theme = 'auto';
    }
    if (!settings.panel || typeof settings.panel !== 'object') {
        settings.panel = structuredClone(defaultSettings.panel);
    }

    // v1.0 은 단일 메모(settings.text)였다. 남아 있으면 첫 메모로 옮긴다.
    if (typeof settings.text === 'string') {
        if (settings.text.trim()) {
            settings.notes.unshift({ id: makeId(), title: '메모', text: settings.text, updatedAt: Date.now() });
        }
        delete settings.text;
    }
    delete settings.activeId;

    return settings;
}

/** 휴지통에서 30일 지난 메모를 지운다. @returns {number} 지운 개수 */
function purgeExpiredTrash() {
    const settings = getSettings();
    const before = settings.trash.length;
    settings.trash = settings.trash.filter(item => Date.now() - (item.deletedAt ?? 0) < TRASH_DAYS * DAY_MS);
    const removed = before - settings.trash.length;
    if (removed) {
        saveSettingsDebounced();
    }
    return removed;
}

/** 휴지통 메모가 지워지기까지 남은 날짜 */
function daysLeft(item) {
    const passed = Math.floor((Date.now() - (item.deletedAt ?? 0)) / DAY_MS);
    return Math.max(0, TRASH_DAYS - passed);
}

/** 고정한 메모가 위로, 그다음은 최근에 고친 순서. */
function getSortedNotes() {
    return [...getSettings().notes].sort((a, b) => {
        if (!!b.pinned !== !!a.pinned) {
            return b.pinned ? 1 : -1;
        }
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
}

function isMobile() {
    return window.innerWidth <= MOBILE_MAX_WIDTH;
}

/**
 * SillyTavern 상단 아이콘 바가 창을 덮지 않도록 그 아래 좌표를 잰다.
 * @returns {number} 창이 시작해도 되는 y 좌표
 */
function getTopOffset() {
    let bottom = 0;
    for (const id of ['top-bar', 'top-settings-holder']) {
        const el = document.getElementById(id);
        if (el && el.offsetHeight) {
            bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
        }
    }
    return Math.min(Math.max(0, bottom), 140);
}

/**
 * 채팅 입력창이 가려지지 않도록 그 위 좌표를 잰다.
 * @returns {number} 창이 끝나야 하는 y 좌표
 */
function getBottomLimit() {
    const viewHeight = window.innerHeight;
    const form = document.getElementById('send_form') ?? document.getElementById('form_sheld');
    if (!form || !form.offsetHeight) {
        return viewHeight;
    }
    const top = form.getBoundingClientRect().top;
    // 화면 위쪽 절반에 잡히면 잘못 잰 값이니 무시한다.
    return top > viewHeight * 0.4 ? Math.min(top, viewHeight) : viewHeight;
}

function setStatus(text, sticky = false) {
    for (const el of document.querySelectorAll('.sm-status-save')) {
        el.textContent = text;
    }
    clearTimeout(statusTimer);
    if (!sticky && text) {
        statusTimer = setTimeout(() => setStatus(''), 2500);
    }
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}. ${pad(date.getDate())}. ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function applyTheme() {
    const theme = getSettings().theme;
    for (const scope of document.querySelectorAll('.sm-scope')) {
        scope.dataset.smTheme = theme;
    }
    for (const select of document.querySelectorAll('.sm-theme')) {
        select.value = theme;
    }
    for (const label of document.querySelectorAll('.sm-theme-label')) {
        label.textContent = THEME_LABELS[theme];
    }
}

function isDirty() {
    return draft !== null && (draft.title !== draft.baseTitle || draft.text !== draft.baseText);
}

function hasContent() {
    return draft !== null && (draft.title.trim() !== '' || draft.text.trim() !== '');
}

function canSave() {
    return isDirty() && hasContent();
}

/* ---------- 임시저장 (이 브라우저에만 보관) ---------- */

function saveDraftLocal() {
    if (!draft) {
        return;
    }
    try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
    } catch {
        // 저장 공간을 못 쓰는 브라우저면 임시저장만 포기한다.
    }
}

function clearDraftLocal() {
    clearTimeout(draftTimer);
    try {
        localStorage.removeItem(DRAFT_KEY);
    } catch {
        // 무시
    }
}

function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftLocal, 500);
}

function readDraftLocal() {
    try {
        return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    } catch {
        return null;
    }
}

/** 창을 열 때 한 번, 저장 못 하고 끊긴 글이 있으면 물어본다. */
async function checkSavedDraft() {
    if (draftChecked) {
        return;
    }
    draftChecked = true;

    const saved = readDraftLocal();
    if (!saved || typeof saved.title !== 'string' || typeof saved.text !== 'string') {
        return;
    }
    if (saved.title === saved.baseTitle && saved.text === saved.baseText) {
        clearDraftLocal();
        return;
    }

    const name = saved.title.trim() || '제목 없음';
    const choice = await showDialog({
        icon: 'fa-rotate-left',
        title: '쓰던 내용을 복구하시겠습니까?',
        message: `"${name}"`,
        buttons: [
            { label: '지우기', value: 'discard', kind: 'soft' },
            { label: '복구', value: 'restore', kind: 'accent' },
        ],
    });

    if (choice !== 'restore') {
        clearDraftLocal();
        return;
    }

    const note = getSettings().notes.find(item => item.id === saved.id);
    draft = {
        id: saved.id ?? makeId(),
        title: saved.title,
        text: saved.text,
        baseTitle: note ? note.title : (saved.baseTitle ?? ''),
        baseText: note ? note.text : (saved.baseText ?? ''),
    };
    selecting = false;
    selected.clear();
    view = 'editor';
    render();
}

/* ---------- 목록 ---------- */

function normalizeQuery(query) {
    return query.trim().toLowerCase();
}

function matchesQuery(note, query) {
    return (note.title || '').toLowerCase().includes(query) || (note.text || '').toLowerCase().includes(query);
}

/**
 * 목록에 보여줄 한 줄. 검색 중이면 검색어가 들어 있는 줄을 우선한다.
 */
function getPreview(note, query) {
    const lines = (note.text || '').split('\n').map(line => line.trim()).filter(Boolean);
    if (query) {
        const hit = lines.find(line => line.toLowerCase().includes(query));
        if (hit) {
            return hit;
        }
    }
    return lines[0] ?? '내용 없음';
}

function makeEmpty(iconClass, headline, hint) {
    const empty = document.createElement('div');
    empty.className = 'sm-empty';
    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconClass}`;
    const title = document.createElement('p');
    title.textContent = headline;
    empty.append(icon, title);

    if (hint) {
        const sub = document.createElement('span');
        sub.textContent = hint;
        empty.append(sub);
    }
    return empty;
}

function makeIconSpan(className, title, icon) {
    const el = document.createElement('span');
    el.className = className;
    el.title = title;
    el.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    return el;
}

function renderList() {
    const settings = getSettings();
    const total = settings.notes.length;
    const query = normalizeQuery(searchQuery);
    const sorted = getSortedNotes();
    const shown = query ? sorted.filter(note => matchesQuery(note, query)) : sorted;

    if (selecting && !total) {
        selecting = false;
    }
    // 선택은 지금 목록에 보이는 메모 안에서만 유지한다. 검색으로 가려진 메모가 몰래 지워지지 않게.
    const shownIds = new Set(shown.map(note => note.id));
    for (const id of [...selected]) {
        if (!selecting || !shownIds.has(id)) {
            selected.delete(id);
        }
    }
    const allShownSelected = shown.length > 0 && shown.every(note => selected.has(note.id));

    for (const el of document.querySelectorAll('.sm-count')) {
        el.textContent = query ? `${shown.length} / ${total}` : String(total);
    }
    for (const el of document.querySelectorAll('.sm-search-clear')) {
        el.classList.toggle('sm-hidden', searchQuery === '');
    }
    for (const el of document.querySelectorAll('.sm-head-normal, .sm-foot-list, .sm-keyboard-option')) {
        el.classList.toggle('sm-hidden', selecting);
    }
    for (const el of document.querySelectorAll('.sm-head-select, .sm-foot-select')) {
        el.classList.toggle('sm-hidden', !selecting);
    }
    for (const el of document.querySelectorAll('.sm-select-start')) {
        el.classList.toggle('sm-hidden', !total);
    }
    for (const el of document.querySelectorAll('.sm-select-count')) {
        el.textContent = `${selected.size}개 선택`;
    }
    for (const el of document.querySelectorAll('.sm-select-all')) {
        el.textContent = allShownSelected ? '전체 해제' : '전체 선택';
        el.disabled = !shown.length;
    }
    for (const el of document.querySelectorAll('.sm-delete-selected')) {
        el.disabled = selected.size === 0;
        el.querySelector('.sm-delete-label').textContent = selected.size ? `${selected.size}개 삭제` : '삭제';
    }
    // 휴지통에 뭔가 있으면 아이콘에 작은 점을 띄운다.
    for (const el of document.querySelectorAll('.sm-trash-dot')) {
        el.classList.toggle('sm-hidden', settings.trash.length === 0);
    }
    for (const el of document.querySelectorAll('.sm-open-trash')) {
        el.title = settings.trash.length ? `휴지통 (${settings.trash.length})` : '휴지통';
    }

    for (const listEl of document.querySelectorAll('.sm-note-list')) {
        listEl.textContent = '';
        listEl.classList.toggle('sm-selecting', selecting);

        if (!total) {
            listEl.append(makeEmpty('fa-note-sticky', '아직 메모가 없습니다', '+ 새 메모를 눌러 추가할 수 있습니다'));
            continue;
        }
        if (!shown.length) {
            listEl.append(makeEmpty('fa-magnifying-glass', '찾는 메모가 없습니다'));
            continue;
        }

        for (const note of shown) {
            const item = document.createElement('div');
            item.className = 'sm-item' + (selected.has(note.id) ? ' sm-checked' : '') + (note.pinned ? ' sm-pinned-item' : '');
            item.dataset.id = note.id;

            const top = document.createElement('div');
            top.className = 'sm-item-top';

            const check = makeIconSpan('sm-check', '', 'fa-check');
            const dot = document.createElement('span');
            dot.className = 'sm-dot';

            const title = document.createElement('span');
            title.className = 'sm-item-title';
            // textContent 로 넣어 제목 속 HTML 이 실행되지 않게 한다.
            title.textContent = note.title || '제목 없음';

            const pin = makeIconSpan(
                'sm-item-pin' + (note.pinned ? ' sm-pinned' : ''),
                note.pinned ? '고정 해제' : '위에 고정',
                'fa-thumbtack');
            const remove = makeIconSpan('sm-item-del', '휴지통으로', 'fa-xmark');

            top.append(check, dot, title, pin, remove);

            const preview = document.createElement('div');
            preview.className = 'sm-item-preview';
            preview.textContent = getPreview(note, query);

            const date = document.createElement('div');
            date.className = 'sm-item-date';
            date.textContent = formatDate(note.updatedAt);

            item.append(top, preview, date);
            listEl.append(item);
        }
    }
}

function renderTrash() {
    const settings = getSettings();
    const items = [...settings.trash].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    if (!items.length) {
        resetTrashSelection();
    }
    const ids = new Set(items.map(note => note.id));
    for (const id of [...selectedTrash]) {
        if (!trashSelecting || !ids.has(id)) {
            selectedTrash.delete(id);
        }
    }
    const allSelected = items.length > 0 && items.every(note => selectedTrash.has(note.id));

    for (const el of document.querySelectorAll('.sm-trash-total')) {
        el.textContent = String(items.length);
    }
    for (const el of document.querySelectorAll('.sm-trash-empty-all')) {
        el.disabled = items.length === 0;
    }
    for (const el of document.querySelectorAll('.sm-trash-head-normal, .sm-trash-foot-normal')) {
        el.classList.toggle('sm-hidden', trashSelecting);
    }
    for (const el of document.querySelectorAll('.sm-trash-head-select, .sm-trash-foot-select')) {
        el.classList.toggle('sm-hidden', !trashSelecting);
    }
    for (const el of document.querySelectorAll('.sm-trash-select-start')) {
        el.classList.toggle('sm-hidden', !items.length);
    }
    for (const el of document.querySelectorAll('.sm-trash-select-count')) {
        el.textContent = `${selectedTrash.size}개 선택`;
    }
    for (const el of document.querySelectorAll('.sm-trash-select-all')) {
        el.textContent = allSelected ? '전체 해제' : '전체 선택';
        el.disabled = !items.length;
    }
    for (const el of document.querySelectorAll('.sm-restore-selected')) {
        el.disabled = selectedTrash.size === 0;
        el.querySelector('.sm-restore-label').textContent = selectedTrash.size ? `${selectedTrash.size}개 복구` : '복구';
    }

    for (const listEl of document.querySelectorAll('.sm-trash-list')) {
        listEl.textContent = '';
        listEl.classList.toggle('sm-selecting', trashSelecting);

        if (!items.length) {
            listEl.append(makeEmpty('fa-trash-can', '휴지통이 비어 있습니다', `메모는 ${TRASH_DAYS}일 동안 보관됩니다`));
            continue;
        }

        for (const note of items) {
            const item = document.createElement('div');
            item.className = 'sm-item sm-trash-item' + (selectedTrash.has(note.id) ? ' sm-checked' : '');
            item.dataset.id = note.id;
            if (trashSelecting) {
                item.setAttribute('role', 'checkbox');
                item.setAttribute('aria-checked', String(selectedTrash.has(note.id)));
                item.tabIndex = 0;
            }

            const top = document.createElement('div');
            top.className = 'sm-item-top';

            const check = makeIconSpan('sm-check', '', 'fa-check');
            const dot = document.createElement('span');
            dot.className = 'sm-dot';

            const title = document.createElement('span');
            title.className = 'sm-item-title';
            title.textContent = note.title || '제목 없음';

            top.append(check, dot, title);

            const preview = document.createElement('div');
            preview.className = 'sm-item-preview';
            preview.textContent = getPreview(note, '');

            const bottom = document.createElement('div');
            bottom.className = 'sm-trash-bottom';

            const left = document.createElement('span');
            left.className = 'sm-item-date';
            const days = daysLeft(note);
            left.textContent = days > 0 ? `${days}일 후 삭제` : '오늘 삭제 예정';

            const actions = document.createElement('span');
            actions.className = 'sm-trash-actions';

            const restore = document.createElement('button');
            restore.type = 'button';
            restore.className = 'sm-mini sm-restore';
            restore.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 복구';

            const purge = document.createElement('button');
            purge.type = 'button';
            purge.className = 'sm-mini sm-purge';
            purge.innerHTML = '<i class="fa-solid fa-trash-can"></i> 영구 삭제';

            actions.append(restore, purge);
            bottom.append(left, actions);
            item.append(top, preview, bottom);
            listEl.append(item);
        }
    }
}

function renderEditor(source = null) {
    const title = draft ? draft.title : '';
    const text = draft ? draft.text : '';

    for (const el of document.querySelectorAll('.sm-title')) {
        if (el !== source) {
            el.value = title;
        }
    }
    for (const el of document.querySelectorAll('.sm-text')) {
        if (el !== source) {
            el.value = text;
        }
    }

    const chars = [...text].length;
    const lines = text.length ? text.split('\n').length : 0;
    for (const el of document.querySelectorAll('.sm-status-count')) {
        el.querySelector('.sm-status-chars').textContent = `${chars.toLocaleString()}자`;
        el.querySelector('.sm-status-lines').textContent = `${lines.toLocaleString()}줄`;
        el.title = `${chars.toLocaleString()}자 / ${lines.toLocaleString()}줄`;
    }
    // 바뀐 게 없거나 비어 있으면 저장 버튼 자체를 막는다.
    for (const el of document.querySelectorAll('.sm-save')) {
        el.disabled = !canSave();
    }
    setStatus(isDirty() ? '저장 안 됨' : '', true);
}

function render(source = null) {
    if (view !== 'trash') {
        resetTrashSelection();
    }
    for (const el of document.querySelectorAll('.sm-view-list')) {
        el.classList.toggle('sm-hidden', view !== 'list');
    }
    for (const el of document.querySelectorAll('.sm-view-editor')) {
        el.classList.toggle('sm-hidden', view !== 'editor');
    }
    for (const el of document.querySelectorAll('.sm-view-trash')) {
        el.classList.toggle('sm-hidden', view !== 'trash');
    }

    if (view === 'list') {
        renderList();
    } else if (view === 'trash') {
        renderTrash();
    } else {
        renderEditor(source);
    }
    applyPanelGeometry();
}

function focusEditor(selector) {
    const target = document.querySelector(`#sm_panel:not(.sm-hidden) ${selector}`);
    if (target) {
        target.focus();
    }
}

/* ---------- 확인창 · 알림 ---------- */

/**
 * 확인창·알림이 공통으로 쓰는 카드. 아이콘 / 제목 / (있으면) 설명 순서.
 */
function makeCard(className, icon, title, message) {
    const box = document.createElement('div');
    box.className = className;

    const iconEl = document.createElement('div');
    iconEl.className = 'sm-dialog-icon';
    iconEl.innerHTML = `<i class="fa-solid ${icon}"></i>`;

    const titleEl = document.createElement('div');
    titleEl.className = 'sm-dialog-title';
    titleEl.textContent = title;

    box.append(iconEl, titleEl);

    if (message) {
        const messageEl = document.createElement('div');
        messageEl.className = 'sm-dialog-msg';
        messageEl.textContent = message;
        box.append(messageEl);
    }
    return box;
}

function closeNotice(immediate = false) {
    clearTimeout(noticeTimer);
    for (const el of document.querySelectorAll('#sm_panel .sm-notice-backdrop')) {
        if (immediate) {
            el.remove();
        } else {
            el.classList.add('sm-leaving');
            setTimeout(() => el.remove(), 160);
        }
    }
}

/**
 * 확인창과 같은 모양의 짧은 알림. 잠깐 떴다가 저절로 사라지고, 누르면 바로 닫힌다.
 */
function showNotice(icon, title, message = '') {
    const panelEl = document.getElementById('sm_panel');
    if (!panelEl) {
        return;
    }
    closeNotice(true);

    const backdrop = document.createElement('div');
    backdrop.className = 'sm-dialog-backdrop sm-notice-backdrop';
    const box = makeCard('sm-dialog sm-notice', icon, title, message);
    box.setAttribute('role', 'status');
    backdrop.append(box);
    backdrop.addEventListener('click', () => closeNotice());
    panelEl.append(backdrop);

    noticeTimer = setTimeout(() => closeNotice(), NOTICE_MS);
}

/**
 * 창 안에 뜨는 확인 대화상자.
 * @param {{icon: string, title: string, message: string, buttons: {label: string, value: string, kind: string}[]}} options
 * @returns {Promise<string|null>} 누른 버튼의 value, 바깥을 누르거나 Esc 면 null
 */
function showDialog({ icon, title, message, buttons }) {
    const panelEl = document.getElementById('sm_panel');
    if (!panelEl || dialogOpen) {
        return Promise.resolve(null);
    }
    closeNotice(true);
    dialogOpen = true;

    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'sm-dialog-backdrop';

        const box = makeCard('sm-dialog', icon, title, message);
        box.setAttribute('role', 'alertdialog');

        const actions = document.createElement('div');
        actions.className = 'sm-dialog-actions';

        const onKey = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close(null);
            }
        };
        const close = (value) => {
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            dialogOpen = false;
            resolve(value);
        };

        for (const button of buttons) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = `sm-btn sm-btn-${button.kind}`;
            el.textContent = button.label;
            el.addEventListener('click', () => close(button.value));
            actions.append(el);
        }

        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) {
                close(null);
            }
        });
        document.addEventListener('keydown', onKey, true);

        box.append(actions);
        backdrop.append(box);
        panelEl.append(backdrop);
    });
}

/* ---------- 편집 ---------- */

function openNote(id) {
    const note = getSettings().notes.find(item => item.id === id);
    if (!note) {
        return;
    }
    selecting = false;
    selected.clear();
    draft = { id: note.id, title: note.title, text: note.text, baseTitle: note.title, baseText: note.text };
    view = 'editor';
    render();
    focusEditor('.sm-text');
}

function newNote() {
    selecting = false;
    selected.clear();
    draft = { id: makeId(), title: '', text: '', baseTitle: '', baseText: '' };
    view = 'editor';
    render();
    focusEditor('.sm-title');
}

function leaveEditor() {
    draft = null;
    clearDraftLocal();
    view = 'list';
    setStatus('');
    render();
}

async function goList() {
    if (isDirty()) {
        const buttons = [
            { label: '계속 쓰기', value: 'stay', kind: 'soft' },
            { label: '저장 안 함', value: 'discard', kind: 'danger' },
        ];
        if (canSave()) {
            buttons.push({ label: '저장', value: 'save', kind: 'accent' });
        }
        const choice = await showDialog({
            icon: 'fa-pen',
            title: '저장하지 않은 내용이 있습니다',
            message: '',
            buttons,
        });
        if (choice === 'save') {
            saveDraft();
            return;
        }
        if (choice !== 'discard') {
            return;
        }
    }
    leaveEditor();
}

function saveDraft() {
    if (!draft) {
        return;
    }
    if (!hasContent()) {
        showNotice('fa-circle-info', '제목이나 내용이 비어 있습니다');
        return;
    }
    if (!isDirty()) {
        return;
    }

    const settings = getSettings();
    const title = draft.title.trim() || '제목 없음';
    let note = settings.notes.find(item => item.id === draft.id);

    if (note) {
        note.title = title;
        note.text = draft.text;
        note.updatedAt = Date.now();
    } else {
        note = { id: draft.id, title, text: draft.text, updatedAt: Date.now(), pinned: false };
        settings.notes.unshift(note);
    }

    // 저장한 메모가 지금 검색어에 안 걸리면 목록에서 안 보이니 검색을 푼다.
    const query = normalizeQuery(searchQuery);
    if (query && !matchesQuery(note, query)) {
        searchQuery = '';
        for (const el of document.querySelectorAll('.sm-search')) {
            el.value = '';
        }
    }

    saveSettingsDebounced();
    leaveEditor();
    showNotice('fa-check', '저장했습니다', `"${title}"`);
}

function copyDraft() {
    if (!draft || !draft.text) {
        showNotice('fa-circle-info', '복사할 내용이 없습니다');
        return;
    }
    navigator.clipboard.writeText(draft.text)
        .then(() => showNotice('fa-copy', '복사했습니다'))
        .catch(() => showNotice('fa-circle-exclamation', '복사하지 못했습니다'));
}

function downloadFile(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}

function downloadDraft() {
    if (!draft || !draft.text) {
        showNotice('fa-circle-info', '내보낼 내용이 없습니다');
        return;
    }
    const safeTitle = (draft.title.trim() || 'memo').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    downloadFile(`${safeTitle}.txt`, draft.text, 'text/plain;charset=utf-8');
}

/* ---------- 고정 ---------- */

function togglePin(id) {
    const note = getSettings().notes.find(item => item.id === id);
    if (!note) {
        return;
    }
    // 고정은 내용을 고친 게 아니니 수정 시각은 건드리지 않는다.
    note.pinned = !note.pinned;
    saveSettingsDebounced();
    renderList();
}

/* ---------- 휴지통 ---------- */

function moveToTrash(ids) {
    const settings = getSettings();
    const targets = settings.notes.filter(note => ids.has(note.id));
    settings.notes = settings.notes.filter(note => !ids.has(note.id));
    for (const note of targets) {
        settings.trash.unshift({ ...note, deletedAt: Date.now() });
    }
    saveSettingsDebounced();
    return targets.length;
}

async function deleteNote(id) {
    const settings = getSettings();
    const note = settings.notes.find(item => item.id === id);
    if (!note) {
        return;
    }
    const name = note.title || '제목 없음';
    const choice = await showDialog({
        icon: 'fa-trash-can',
        title: '휴지통으로 옮기시겠습니까?',
        message: `"${name}"\n휴지통에서 ${TRASH_DAYS}일 안에 복구할 수 있습니다`,
        buttons: [
            { label: '취소', value: 'cancel', kind: 'soft' },
            { label: '휴지통으로', value: 'delete', kind: 'danger' },
        ],
    });
    if (choice !== 'delete') {
        return;
    }
    moveToTrash(new Set([id]));
    render();
    showNotice('fa-trash-can', '휴지통으로 옮겼습니다', `"${name}"`);
}

async function deleteSelected() {
    const count = selected.size;
    if (!count) {
        return;
    }
    const settings = getSettings();
    const isAll = count === settings.notes.length;
    const choice = await showDialog({
        icon: 'fa-trash-can',
        title: isAll ? '메모를 모두 휴지통으로 옮기시겠습니까?' : `메모 ${count}개를 휴지통으로 옮기시겠습니까?`,
        message: `휴지통에서 ${TRASH_DAYS}일 안에 복구할 수 있습니다`,
        buttons: [
            { label: '취소', value: 'cancel', kind: 'soft' },
            { label: '휴지통으로', value: 'delete', kind: 'danger' },
        ],
    });
    if (choice !== 'delete') {
        return;
    }
    const moved = moveToTrash(new Set(selected));
    selecting = false;
    selected.clear();
    render();
    showNotice('fa-trash-can', `${moved}개를 휴지통으로 옮겼습니다`);
}

function openTrash() {
    selecting = false;
    selected.clear();
    resetTrashSelection();
    const removed = purgeExpiredTrash();
    view = 'trash';
    render();
    if (removed) {
        showNotice('fa-trash-can', `오래된 메모 ${removed}개를 지웠습니다`);
    }
}

function resetTrashSelection() {
    trashSelecting = false;
    selectedTrash.clear();
}

function setTrashSelecting(on) {
    resetTrashSelection();
    trashSelecting = on && getSettings().trash.length > 0;
    renderTrash();
}

function toggleTrashSelected(id) {
    if (!trashSelecting || !getSettings().trash.some(note => note.id === id)) {
        return;
    }
    if (selectedTrash.has(id)) {
        selectedTrash.delete(id);
    } else {
        selectedTrash.add(id);
    }
    renderTrash();
}

function toggleTrashSelectAll() {
    if (!trashSelecting) {
        return;
    }
    const items = getSettings().trash;
    const allSelected = items.length > 0 && items.every(note => selectedTrash.has(note.id));
    selectedTrash.clear();
    if (!allSelected) {
        for (const note of items) {
            selectedTrash.add(note.id);
        }
    }
    renderTrash();
}

/** 선택한 메모만 옮긴다. 재호출하거나 같은 ID가 있어도 기존 메모를 덮어쓰지 않는다. */
function restoreTrashed(ids) {
    const settings = getSettings();
    const existing = new Set(settings.notes.map(note => note.id));
    const restored = [];
    settings.trash = settings.trash.filter(note => {
        if (!ids.has(note.id) || existing.has(note.id)) {
            return true;
        }
        const recovered = { ...note };
        delete recovered.deletedAt;
        restored.push(recovered);
        existing.add(note.id);
        return false;
    });
    if (restored.length) {
        settings.notes.unshift(...restored);
        saveSettingsDebounced();
    }
    return restored;
}

function restoreNote(id) {
    const [note] = restoreTrashed(new Set([id]));
    if (!note) {
        return;
    }
    renderTrash();
    showNotice('fa-rotate-left', '복구했습니다', `"${note.title || '제목 없음'}"`);
}

function restoreSelectedTrash() {
    if (!trashSelecting || !selectedTrash.size) {
        return;
    }
    const restored = restoreTrashed(new Set(selectedTrash));
    resetTrashSelection();
    renderTrash();
    if (restored.length) {
        showNotice('fa-rotate-left', `${restored.length}개를 복구했습니다`);
    }
}

async function purgeNote(id) {
    const settings = getSettings();
    const note = settings.trash.find(item => item.id === id);
    if (!note) {
        return;
    }
    const name = note.title || '제목 없음';
    const choice = await showDialog({
        icon: 'fa-trash-can',
        title: '완전히 삭제하시겠습니까?',
        message: `"${name}"\n되돌릴 수 없습니다`,
        buttons: [
            { label: '취소', value: 'cancel', kind: 'soft' },
            { label: '영구 삭제', value: 'purge', kind: 'danger' },
        ],
    });
    if (choice !== 'purge') {
        return;
    }
    settings.trash = settings.trash.filter(item => item.id !== id);
    saveSettingsDebounced();
    renderTrash();
    showNotice('fa-trash-can', '삭제했습니다');
}

async function emptyTrash() {
    const settings = getSettings();
    const count = settings.trash.length;
    if (!count) {
        return;
    }
    const choice = await showDialog({
        icon: 'fa-trash-can',
        title: '휴지통을 비우시겠습니까?',
        message: `메모 ${count}개가 완전히 지워집니다\n되돌릴 수 없습니다`,
        buttons: [
            { label: '취소', value: 'cancel', kind: 'soft' },
            { label: '비우기', value: 'empty', kind: 'danger' },
        ],
    });
    if (choice !== 'empty') {
        return;
    }
    settings.trash = [];
    saveSettingsDebounced();
    renderTrash();
    showNotice('fa-trash-can', '휴지통을 비웠습니다');
}

/* ---------- 백업 ---------- */

function exportBackup() {
    const notes = getSettings().notes.map(note => ({
        id: note.id,
        title: note.title,
        text: note.text,
        updatedAt: note.updatedAt,
        pinned: !!note.pinned,
    }));
    if (!notes.length) {
        showNotice('fa-circle-info', '내보낼 메모가 없습니다');
        return;
    }
    const data = { app: 'st-memo', version: 1, exportedAt: new Date().toISOString(), notes };
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`memo-backup-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
    showNotice('fa-download', '백업 파일을 저장했습니다', `메모 ${notes.length}개`);
}

function requestImport() {
    const input = document.querySelector('#sm_panel .sm-import-file');
    if (input) {
        input.click();
    }
}

async function importBackup(file) {
    let data = null;
    try {
        data = JSON.parse(await file.text());
    } catch {
        showNotice('fa-circle-exclamation', '읽을 수 없는 파일입니다', '메모장에서 내보낸 백업 파일만 불러올 수 있습니다');
        return;
    }

    const incoming = Array.isArray(data?.notes) ? data.notes : null;
    if (!incoming) {
        showNotice('fa-circle-exclamation', '메모가 없는 파일입니다', '메모장에서 내보낸 백업 파일만 불러올 수 있습니다');
        return;
    }

    const settings = getSettings();
    const taken = new Set([...settings.notes, ...settings.trash].map(note => note.id));
    const cleaned = incoming
        .filter(note => note && typeof note.title === 'string' && typeof note.text === 'string')
        .map(note => ({
            id: typeof note.id === 'string' ? note.id : makeId(),
            title: note.title,
            text: note.text,
            updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : Date.now(),
            pinned: !!note.pinned,
        }));
    const fresh = cleaned.filter(note => !taken.has(note.id));
    const skipped = cleaned.length - fresh.length;

    if (!cleaned.length) {
        showNotice('fa-circle-exclamation', '불러올 메모가 없습니다');
        return;
    }
    if (!fresh.length) {
        showNotice('fa-circle-info', '새로 불러올 메모가 없습니다');
        return;
    }

    const choice = await showDialog({
        icon: 'fa-file-import',
        title: `메모 ${fresh.length}개를 불러오시겠습니까?`,
        message: skipped
            ? '이미 있는 메모 제외'
            : '',
        buttons: [
            { label: '취소', value: 'cancel', kind: 'soft' },
            { label: '불러오기', value: 'import', kind: 'accent' },
        ],
    });
    if (choice !== 'import') {
        return;
    }

    settings.notes.push(...fresh);
    saveSettingsDebounced();
    view = 'list';
    render();
    showNotice('fa-file-import', `메모 ${fresh.length}개를 불러왔습니다`, skipped ? '이미 있는 메모 제외' : '');
}

/* ---------- 선택 모드 ---------- */

function setSelecting(on) {
    selecting = on;
    selected.clear();
    renderList();
}

function toggleSelected(id) {
    if (selected.has(id)) {
        selected.delete(id);
    } else {
        selected.add(id);
    }
    renderList();
}

function toggleSelectAll() {
    const query = normalizeQuery(searchQuery);
    const shown = getSortedNotes().filter(note => !query || matchesQuery(note, query));
    const allSelected = shown.length > 0 && shown.every(note => selected.has(note.id));
    for (const note of shown) {
        if (allSelected) {
            selected.delete(note.id);
        } else {
            selected.add(note.id);
        }
    }
    renderList();
}

/* ---------- 창 ---------- */

/**
 * 창 크기를 화면에 맞춘다. 폰에서는 상단 아이콘 바와 채팅 입력창 사이를 채우고,
 * PC에서는 저장된 크기를 쓰되 화면 밖으로 나가지 않게 한다.
 */
function applyPanelGeometry() {
    const el = document.getElementById('sm_panel');
    if (!el) {
        return;
    }
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const safeTop = getTopOffset() + EDGE;

    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const visibleBottom = Math.min(viewHeight, viewportTop + (viewport?.height ?? viewHeight));
    const top = Math.max(safeTop, viewportTop + EDGE);
    let compact = isMobile() && view === 'editor' && visibleBottom - top < 500;

    if (isMobile()) {
        // 편집 공간이 좁을 때는 채팅 입력창 몫까지 메모 입력에 사용한다.
        const bottom = (compact ? visibleBottom : Math.min(getBottomLimit(), visibleBottom)) - EDGE;
        const orientation = window.screen?.orientation?.type ?? window.orientation ?? null;
        const visualHeight = viewport?.height ?? viewHeight;
        const reduced = mobileGeometry
            && mobileGeometry.width === viewWidth
            && mobileGeometry.orientation === orientation
            && (viewHeight < mobileGeometry.viewHeight || visualHeight < mobileGeometry.visualHeight);
        let geometry = { top, height: Math.max(0, bottom - top) };
        // 옵션을 끈 상태에서도 키보드가 열리기 전 크기를 기억한다.
        if (!reduced) {
            mobileGeometry = { ...geometry, width: viewWidth, viewHeight, visualHeight, orientation, compact };
        } else if (getSettings().keepSizeWithKeyboard) {
            geometry = mobileGeometry;
            compact = mobileGeometry.compact;
        }
        el.classList.toggle('sm-compact-editor', compact);
        el.classList.add('sm-mobile');
        el.style.left = `${EDGE}px`;
        el.style.top = `${geometry.top}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.width = `${viewWidth - EDGE * 2}px`;
        el.style.height = `${geometry.height}px`;
        return;
    }

    mobileGeometry = null;
    el.classList.remove('sm-mobile');
    el.classList.remove('sm-compact-editor');
    const panel = getSettings().panel;
    const width = Math.min(panel.width, viewWidth - EDGE * 2);
    const height = Math.min(panel.height, viewHeight - safeTop - EDGE);
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;

    if (panel.left === null || panel.top === null) {
        el.style.left = 'auto';
        el.style.top = `${safeTop}px`;
        el.style.right = '20px';
        return;
    }

    const maxLeft = Math.max(EDGE, viewWidth - width - EDGE);
    const maxTop = Math.max(safeTop, viewHeight - height - EDGE);
    el.style.left = `${Math.min(Math.max(EDGE, panel.left), maxLeft)}px`;
    el.style.top = `${Math.min(Math.max(safeTop, panel.top), maxTop)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
}

/**
 * 페이지를 막 불러온 직후에는 상단 바·입력창 크기가 아직 안 잡혀 있을 수 있어
 * 몇 번 더 다시 잰다.
 */
function refitPanel() {
    applyPanelGeometry();
    requestAnimationFrame(applyPanelGeometry);
    setTimeout(applyPanelGeometry, 400);
    setTimeout(applyPanelGeometry, 1500);
}

function setPanelOpen(open) {
    const settings = getSettings();
    settings.panel.open = open;
    $('#sm_panel').toggleClass('sm-hidden', !open);
    if (open) {
        refitPanel();
        checkSavedDraft();
    } else {
        resetTrashSelection();
        if (view === 'trash') {
            renderTrash();
        }
    }
    saveSettingsDebounced();
}

function makeDraggable(panelEl, handleEl) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, pointerId = null;

    handleEl.addEventListener('pointerdown', (event) => {
        if (isMobile() || event.target.closest('.sm-panel-btn')) {
            return;
        }
        const rect = panelEl.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        pointerId = event.pointerId;
        handleEl.setPointerCapture(pointerId);
        event.preventDefault();
    });

    handleEl.addEventListener('pointermove', (event) => {
        if (pointerId === null || event.pointerId !== pointerId) {
            return;
        }
        const width = panelEl.offsetWidth;
        const height = panelEl.offsetHeight;
        const left = Math.min(Math.max(0, startLeft + event.clientX - startX), Math.max(0, window.innerWidth - width));
        const top = Math.min(Math.max(0, startTop + event.clientY - startY), Math.max(0, window.innerHeight - height));
        panelEl.style.left = `${left}px`;
        panelEl.style.top = `${top}px`;
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
    });

    const endDrag = (event) => {
        if (pointerId === null || event.pointerId !== pointerId) {
            return;
        }
        handleEl.releasePointerCapture(pointerId);
        pointerId = null;
        const rect = panelEl.getBoundingClientRect();
        const panel = getSettings().panel;
        panel.left = Math.round(rect.left);
        panel.top = Math.round(rect.top);
        saveSettingsDebounced();
    };

    handleEl.addEventListener('pointerup', endDrag);
    handleEl.addEventListener('pointercancel', endDrag);
}

function watchPanelResize(panelEl) {
    if (typeof ResizeObserver === 'undefined') {
        return;
    }
    let resizeTimer = null;
    new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            // 모바일 크기는 화면에 맞춰 강제한 값이라 저장하지 않는다.
            if (isMobile() || panelEl.classList.contains('sm-hidden')) {
                return;
            }
            const panel = getSettings().panel;
            const width = Math.round(panelEl.offsetWidth);
            const height = Math.round(panelEl.offsetHeight);
            if (width && height && (width !== panel.width || height !== panel.height)) {
                panel.width = width;
                panel.height = height;
                saveSettingsDebounced();
            }
        }, 300);
    }).observe(panelEl);
}

const panelHtml = `
<div id="sm_panel" class="sm-scope sm-hidden">
    <div class="sm-panel-header">
        <span class="sm-panel-title"><i class="fa-solid fa-note-sticky"></i> 심플메모장</span>
        <div class="sm-panel-btn sm-close" title="닫기"><i class="fa-solid fa-xmark"></i></div>
    </div>
    <div class="sm-body">
        <div class="sm-view-list">
            <div class="sm-head sm-head-normal">
                <span class="sm-head-title">내 메모<span class="sm-count">0</span></span>
                <button type="button" class="sm-btn sm-btn-soft sm-select-start" title="여러 개 골라서 삭제">선택</button>
                <button type="button" class="sm-btn sm-btn-accent sm-add">
                    <i class="fa-solid fa-plus"></i> 새 메모
                </button>
            </div>
            <div class="sm-head sm-head-select sm-hidden">
                <span class="sm-head-title"><span class="sm-select-count">0개 선택</span></span>
                <button type="button" class="sm-btn sm-btn-soft sm-select-all">전체 선택</button>
                <button type="button" class="sm-btn sm-btn-soft sm-select-cancel">취소</button>
            </div>
            <label class="sm-search-box">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="text" class="sm-search" placeholder="제목이나 내용으로 검색" enterkeyhint="search" autocomplete="off">
                <button type="button" class="sm-search-clear sm-hidden" title="검색어 지우기">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </label>
            <div class="sm-list sm-note-list"></div>
            <div class="sm-foot sm-foot-list">
                <span class="sm-foot-actions">
                    <button type="button" class="sm-icon-btn sm-open-trash" title="휴지통">
                        <i class="fa-solid fa-trash-can"></i>
                        <span class="sm-trash-dot sm-hidden"></span>
                    </button>
                    <button type="button" class="sm-icon-btn sm-export" title="백업 내보내기">
                        <i class="fa-solid fa-download"></i>
                    </button>
                    <button type="button" class="sm-icon-btn sm-import" title="백업 불러오기">
                        <i class="fa-solid fa-file-import"></i>
                    </button>
                </span>
                <span class="sm-theme-pill" title="테마">
                    <span class="sm-theme-label">자동</span>
                    <i class="fa-solid fa-chevron-down"></i>
                    <select class="sm-theme" aria-label="테마">
                        <option value="auto">자동</option>
                        <option value="light">라이트</option>
                        <option value="dark">다크</option>
                    </select>
                </span>
            </div>
            <label class="sm-keyboard-option" title="모바일에서 사용합니다. 켜면 메모장 아래쪽이 키보드에 가려질 수 있습니다.">
                <input type="checkbox" class="sm-keep-keyboard-size">
                <span>키보드가 열려도 메모장 크기 유지</span>
            </label>
            <div class="sm-foot sm-foot-select sm-hidden">
                <button type="button" class="sm-btn sm-btn-danger sm-delete-selected" disabled>
                    <i class="fa-solid fa-trash-can"></i> <span class="sm-delete-label">삭제</span>
                </button>
            </div>
        </div>

        <div class="sm-view-trash sm-hidden">
            <div class="sm-head sm-trash-head-normal">
                <button type="button" class="sm-btn sm-btn-round sm-trash-back" title="목록으로">
                    <i class="fa-solid fa-arrow-left"></i>
                </button>
                <span class="sm-head-title">휴지통<span class="sm-count sm-trash-total">0</span></span>
                <button type="button" class="sm-btn sm-btn-soft sm-trash-select-start" title="여러 개 골라서 복구">선택</button>
                <button type="button" class="sm-btn sm-btn-danger sm-trash-empty-all" disabled>비우기</button>
            </div>
            <div class="sm-head sm-trash-head-select sm-hidden">
                <span class="sm-head-title"><span class="sm-trash-select-count">0개 선택</span></span>
                <button type="button" class="sm-btn sm-btn-soft sm-trash-select-all">전체 선택</button>
                <button type="button" class="sm-btn sm-btn-soft sm-trash-select-cancel">취소</button>
            </div>
            <div class="sm-list sm-trash-list"></div>
            <div class="sm-foot sm-trash-foot-normal">
                <span>${TRASH_DAYS}일 뒤 자동으로 지워집니다</span>
            </div>
            <div class="sm-foot sm-trash-foot-select sm-hidden">
                <button type="button" class="sm-btn sm-btn-accent sm-restore-selected" disabled>
                    <i class="fa-solid fa-rotate-left"></i> <span class="sm-restore-label">복구</span>
                </button>
            </div>
        </div>

        <div class="sm-view-editor sm-hidden">
            <div class="sm-head">
                <button type="button" class="sm-btn sm-btn-round sm-back" title="목록으로">
                    <i class="fa-solid fa-arrow-left"></i>
                </button>
                <input type="text" class="sm-title" placeholder="제목" maxlength="100">
                <button type="button" class="sm-btn sm-btn-accent sm-save" title="저장" disabled>
                    <i class="fa-solid fa-check"></i> 저장
                </button>
            </div>
            <textarea class="sm-text" placeholder="내용"></textarea>
            <div class="sm-foot sm-editor-foot">
                <span class="sm-status-save"></span>
                <span class="sm-editor-actions">
                    <button type="button" class="sm-mini sm-copy"><i class="fa-solid fa-copy"></i> 복사</button>
                    <button type="button" class="sm-mini sm-download"><i class="fa-solid fa-download"></i> 내보내기</button>
                </span>
                <span class="sm-status-count">
                    <span class="sm-status-chars"></span>
                    <span class="sm-status-lines"></span>
                </span>
            </div>
        </div>
    </div>
    <input type="file" class="sm-import-file sm-hidden" accept="application/json,.json">
</div>`;

const menuButtonHtml = `
<div id="sm_menu_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
    <i class="fa-solid fa-note-sticky"></i>
    <span>심플메모장</span>
</div>`;

jQuery(async () => {
    const settings = getSettings();

    $('body').append(panelHtml);
    $('#sm_panel .sm-keep-keyboard-size').prop('checked', settings.keepSizeWithKeyboard);
    $('#extensionsMenu').append(menuButtonHtml);

    purgeExpiredTrash();
    applyTheme();
    render();

    $(document).on('input', '.sm-title', function () {
        if (!draft) {
            return;
        }
        draft.title = this.value;
        renderEditor(this);
        scheduleDraftSave();
    });

    $(document).on('input', '.sm-text', function () {
        if (!draft) {
            return;
        }
        draft.text = this.value;
        renderEditor(this);
        scheduleDraftSave();
    });

    $(document).on('keydown', '.sm-title, .sm-text', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            saveDraft();
        }
    });

    $(document).on('input', '.sm-search', function () {
        searchQuery = this.value;
        renderList();
    });

    $(document).on('click', '.sm-search-clear', (event) => {
        event.preventDefault();
        searchQuery = '';
        for (const el of document.querySelectorAll('.sm-search')) {
            el.value = '';
        }
        renderList();
        focusEditor('.sm-search');
    });

    $(document).on('change', '.sm-keep-keyboard-size', function () {
        getSettings().keepSizeWithKeyboard = this.checked;
        saveSettingsDebounced();
        applyPanelGeometry();
    });

    $(document).on('change', '.sm-theme', function () {
        getSettings().theme = THEMES.includes(this.value) ? this.value : 'auto';
        applyTheme();
        saveSettingsDebounced();
    });

    $(document).on('click', '.sm-item', function (event) {
        const id = this.dataset.id;
        if (this.classList.contains('sm-trash-item')) {
            if (trashSelecting) {
                toggleTrashSelected(id);
            } else if (event.target.closest('.sm-restore')) {
                restoreNote(id);
            } else if (event.target.closest('.sm-purge')) {
                purgeNote(id);
            }
            return;
        }
        if (selecting) {
            toggleSelected(id);
        } else if (event.target.closest('.sm-item-pin')) {
            togglePin(id);
        } else if (event.target.closest('.sm-item-del')) {
            deleteNote(id);
        } else {
            openNote(id);
        }
    });

    $(document).on('click', '.sm-add', newNote);
    $(document).on('click', '.sm-select-start', () => setSelecting(true));
    $(document).on('click', '.sm-select-cancel', () => setSelecting(false));
    $(document).on('click', '.sm-select-all', toggleSelectAll);
    $(document).on('click', '.sm-delete-selected', deleteSelected);
    $(document).on('click', '.sm-back', goList);
    $(document).on('click', '.sm-save', saveDraft);
    $(document).on('click', '.sm-copy', copyDraft);
    $(document).on('click', '.sm-download', downloadDraft);
    $(document).on('click', '.sm-open-trash', openTrash);
    $(document).on('click', '.sm-export', exportBackup);
    $(document).on('click', '.sm-import', requestImport);
    $(document).on('click', '.sm-trash-back', () => { view = 'list'; render(); });
    $(document).on('click', '.sm-trash-select-start', () => setTrashSelecting(true));
    $(document).on('click', '.sm-trash-select-cancel', () => setTrashSelecting(false));
    $(document).on('click', '.sm-trash-select-all', toggleTrashSelectAll);
    $(document).on('click', '.sm-restore-selected', restoreSelectedTrash);
    $(document).on('keydown', '.sm-trash-item', function (event) {
        if (trashSelecting && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            const id = this.dataset.id;
            toggleTrashSelected(id);
            document.querySelectorAll('.sm-trash-item').forEach(item => {
                if (item.dataset.id === id) {
                    item.focus();
                }
            });
        }
    });
    $(document).on('click', '.sm-trash-empty-all', emptyTrash);
    $(document).on('click', '.sm-close', () => setPanelOpen(false));
    $('#sm_menu_button').on('click', () => setPanelOpen($('#sm_panel').hasClass('sm-hidden')));

    $(document).on('change', '.sm-import-file', function () {
        const file = this.files?.[0];
        this.value = '';
        if (file) {
            importBackup(file);
        }
    });

    const panelEl = document.getElementById('sm_panel');
    makeDraggable(panelEl, panelEl.querySelector('.sm-panel-header'));
    watchPanelResize(panelEl);

    // 키보드와 화면 회전에 맞춰 실제 보이는 영역에 배치한다.
    let viewportTimer = null;
    const onViewportResize = () => {
        if (panelEl.classList.contains('sm-hidden')) {
            return;
        }
        clearTimeout(viewportTimer);
        viewportTimer = setTimeout(applyPanelGeometry, 200);
    };
    window.addEventListener('resize', onViewportResize);
    window.visualViewport?.addEventListener('resize', onViewportResize);
    window.visualViewport?.addEventListener('scroll', onViewportResize);

    if (settings.panel.open) {
        setPanelOpen(true);
    } else {
        applyPanelGeometry();
    }
});
