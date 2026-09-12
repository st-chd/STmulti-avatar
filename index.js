/**
 * 캐릭터·페르소나 추가 아바타 관리.
 * 목록은 기본 이미지, 채팅은 방별 선택을 우선한다.
 */

import { user_avatar } from '../../../personas.js';

const KEY = 'multiAvatar';
const IMG_ROOT = 'user/images';
const PERSONA_PREFIX = 'persona:';
const isPersona = key => key.startsWith(PERSONA_PREFIX);
const avatarFile = key => isPersona(key) ? key.slice(PERSONA_PREFIX.length) : key;
const personaKey = file => `${PERSONA_PREFIX}${file}`;

const ctx = () => SillyTavern.getContext();

const charIndex = (key) => ctx().characters.findIndex(c => c?.avatar === key);

function cardData(key) {
    if (isPersona(key)) return ctx().extensionSettings[KEY]?.personas?.[avatarFile(key)] ?? null;
    const c = ctx().characters.find(x => x?.avatar === key);
    return c?.data?.extensions?.[KEY] ?? null;
}

async function writeCard(key, data) {
    if (isPersona(key)) {
        const c = ctx();
        const settings = c.extensionSettings[KEY] ??= {};
        const personas = settings.personas ??= {};
        if (data === undefined) delete personas[avatarFile(key)];
        else personas[avatarFile(key)] = data;
        if (!Object.keys(personas).length) delete settings.personas;
        if (!Object.keys(settings).length) delete c.extensionSettings[KEY];
        c.saveSettingsDebounced();
        return;
    }
    const id = charIndex(key);
    if (id < 0) return;
    await ctx().writeExtensionField(id, KEY, data === undefined ? ctx().constants.unset : data);
}

/** 채팅별 선택값. undefined는 미설정, 빈 문자열은 원본 고정. */
const chatOverride = (key) => ctx().chatMetadata?.[KEY]?.[key];

async function setChatOverride(key, value) {
    const c = ctx();
    const map = { ...(c.chatMetadata?.[KEY] ?? {}) };
    if (value === undefined) delete map[key];
    else map[key] = value;
    replaceChatMap(map);
    await c.saveMetadata();
    refresh();
}

function replaceChatMap(map) {
    const c = ctx();
    const metadata = { ...c.chatMetadata };
    if (Object.keys(map).length) metadata[KEY] = map;
    else delete metadata[KEY];
    c.updateChatMetadata(metadata, true);
}

/** 표시할 파일명. 삭제된 파일과 null은 원본으로 처리한다. */
function resolve(key, mode) {
    const card = cardData(key);
    const alive = (f) => !!f && !!card?.files?.includes(f);

    if (mode === 'chat') {
        const ov = chatOverride(key);
        if (ov === '') return null;
        if (alive(ov)) return ov;
    }
    return alive(card?.list) ? card.list : null;
}

/** 이미지 폴더명. 구버전 데이터는 파일명에서 기존 폴더를 추론한다. */
function dirOf(key) {
    const d = cardData(key);
    if (d?.dir) return d.dir;
    const m = /^(.*)_add\d+\.[^.]+$/.exec(d?.files?.[0] ?? '');
    if (m) return `${m[1]}.png`;
    // dir 없는 기존 데이터는 기존 폴더를 유지하고, 새 라이브러리만 새 이름을 쓴다.
    if (d?.files?.length) return key;
    const base = avatarFile(key).replace(/\.[^.]+$/, '');
    return `${isPersona(key) ? 'persona_' : ''}${base}_avatar`;
}

// 테마가 경로 표기를 바꿔도 반복 교체되지 않도록 절대 경로를 사용한다.
const imgUrl = (key, file) => `/${IMG_ROOT}/${encodeURIComponent(dirOf(key))}/${encodeURIComponent(file)}`;

/** 같은 리소스를 가리키는 URL인지 경로와 검색 문자열만 비교한다. */
function sameUrl(a, b) {
    if (!a || !b) return false;
    const norm = (u) => {
        try { return new URL(u, location.origin).pathname + new URL(u, location.origin).search; }
        catch { return u; }
    };
    return norm(a) === norm(b);
}

/** 실리태번 원본 아바타 썸네일 경로. */
const originalThumbUrl = (key) => `/thumbnail?type=${isPersona(key) ? 'persona' : 'avatar'}&file=${encodeURIComponent(avatarFile(key))}`;
const originalUrl = key => `/${isPersona(key) ? 'User%20Avatars' : 'characters'}/${encodeURIComponent(avatarFile(key))}`;

/** 파일이 사라진 썸네일은 깨진 아이콘 대신 경고 표시로 바꾼다 */
function markMissing(img) {
    img.onerror = () => {
        img.onerror = null;
        const box = img.parentElement;
        img.remove();
        const warn = document.createElement('div');
        warn.className = 'ma-missing fa-solid fa-triangle-exclamation';
        warn.title = '이미지 파일을 찾을 수 없습니다';
        box?.prepend(warn);
    };
}

/** 아바타 URL에서 캐릭터 또는 페르소나 키를 추출한다. */
function avatarKeyOf(src) {
    if (!src) return null;
    try {
        const url = new URL(src, location.origin);
        if (url.origin !== location.origin) return null;
        if (url.pathname === '/thumbnail') {
            const file = url.searchParams.get('file');
            const type = url.searchParams.get('type');
            if (!file) return null;
            if (type === 'avatar') return file;
            if (type === 'persona') return personaKey(file);
        }
        const m = /^\/(characters|User Avatars)\/([^/]+)$/.exec(decodeURIComponent(url.pathname));
        return m ? (m[1] === 'characters' ? m[2] : personaKey(m[2])) : null;
    } catch { return null; }
}

/** 이미지 교체 전에 로드 가능 여부를 확인해 아바타가 사라지는 것을 막는다. */
const probed = new Map();
function probe(url) {
    const cached = probed.get(url);
    if (cached && cached.expires > Date.now()) return cached.promise;

    const entry = { expires: Infinity };
    const p = new Promise((res) => {
        const t = new Image();
        t.onload = () => res(true);
        t.onerror = () => res(false);
        t.src = url;
    });
    // 없는 파일은 렌더마다 재요청하지 않고 30초 뒤 다음 렌더에서 재확인한다.
    p.then((ok) => { if (!ok) entry.expires = Date.now() + 30_000; });
    entry.promise = p;
    probed.delete(url);
    if (probed.size >= 256) probed.delete(probed.keys().next().value);
    probed.set(url, entry);
    return p;
}

/** Moonlit Echoes 테마의 메시지 아바타 CSS 변수를 함께 갱신한다. */
function syncThemeVars(img, thumb, original = thumb) {
    const mes = img.closest('.mes');
    if (!mes || mes.dataset.avatar === undefined) return;

    const abs = (u) => new URL(u, location.origin).href;
    const t = abs(thumb);
    const o = abs(original);

    mes.dataset.avatarThumb = t;
    mes.dataset.avatarOriginal = o;
    mes.dataset.avatar = t;
    mes.style.setProperty('--mes-avatar-thumb-url', `url('${t}')`);
    mes.style.setProperty('--mes-avatar-original-url', `url('${o}')`);
    mes.style.setProperty('--mes-avatar-url', `url('${t}')`);
}

/** 목록 또는 채팅 규칙에 맞춰 아바타를 교체한다. */
function swap(root, mode) {
    if (!root) return;
    for (const img of root.querySelectorAll('.avatar img, #avatar_load_preview')) {
        // 원본 URL이 있으면 이름 변경에도 맞는 최신 키를 읽는다.
        const fromSrc = avatarKeyOf(img.getAttribute('src'));
        // 재사용된 메시지는 현재 추가 이미지일 때만 저장된 키를 사용한다.
        const cachedKey = img.dataset.maKey;
        const cachedFile = cachedKey && resolve(cachedKey, mode);
        const src = img.getAttribute('src');
        const isReplacement = cachedKey && (sameUrl(src, img.dataset.maApplied)
            || (cachedFile && sameUrl(src, imgUrl(cachedKey, cachedFile))));
        const key = fromSrc ?? (isReplacement ? cachedKey : null);
        if (!key) {
            delete img.dataset.maKey;
            delete img.dataset.maOrig;
            delete img.dataset.maApplied;
            continue;
        }

        const mes = img.closest('.mes');
        if (mes && (mes.getAttribute('is_system') === 'true'
            || (mes.getAttribute('is_user') === 'true') !== isPersona(key))) {
            delete img.dataset.maKey;
            delete img.dataset.maOrig;
            delete img.dataset.maApplied;
            continue;
        }

        if (fromSrc) {
            img.dataset.maKey = fromSrc;
            img.dataset.maOrig = img.getAttribute('src');
        }

        const file = resolve(key, mode);
        const wantUrl = file ? imgUrl(key, file) : img.dataset.maOrig;
        if (sameUrl(img.getAttribute('src'), wantUrl)) continue;

        if (!file) {
            img.src = img.dataset.maOrig;
            delete img.dataset.maApplied;
            syncThemeVars(img, img.dataset.maOrig, originalUrl(key));
            continue;
        }

        probe(wantUrl).then((ok) => {
            // 대기 중 설정이나 요소가 바뀌면 적용하지 않는다.
            if (!img.isConnected || img.dataset.maKey !== key || resolve(key, mode) !== file
                || !sameUrl(img.getAttribute('src'), src) || sameUrl(img.getAttribute('src'), wantUrl)) return;
            if (ok) {
                img.dataset.maApplied = wantUrl;
                img.src = wantUrl;
                syncThemeVars(img, wantUrl);
            } else {
                if (!sameUrl(img.getAttribute('src'), img.dataset.maOrig)) img.src = img.dataset.maOrig;
                delete img.dataset.maApplied;
                syncThemeVars(img, img.dataset.maOrig, originalUrl(key));
            }
        });
    }
}

// 다음 렌더에서 원본 URL로 키를 다시 읽도록 표시를 지운다.
function resetMarks() {
    for (const img of document.querySelectorAll('img[data-ma-key]')) {
        if (img.dataset.maOrig) img.src = img.dataset.maOrig;
        delete img.dataset.maKey;
        delete img.dataset.maOrig;
        delete img.dataset.maApplied;
    }
}

// 목록·채팅·편집창의 아바타와 채팅 버튼을 갱신한다.
function refresh() {
    swap(document.getElementById('rm_print_characters_block'), 'list');
    swap(document.getElementById('avatar_div'), 'list');
    swap(document.getElementById('user_avatar_block'), 'list');
    const chat = document.getElementById('chat');
    swap(chat, 'chat');
    syncMesButtons(chat);
}

/** 추가 이미지가 있는 메시지에만 선택 버튼을 표시한다. */
function syncMesButtons(root) {
    if (!root) return;
    const list = root.matches?.('.mes') ? [root] : root.querySelectorAll('.mes');
    for (const mes of list) {
        const key = mes.querySelector('.avatar img')?.dataset.maKey;
        const wanted = !!key && mes.getAttribute('is_system') !== 'true'
            && (mes.getAttribute('is_user') === 'true') === isPersona(key)
            && !!cardData(key)?.files?.length;
        const btn = mes.querySelector('.ma-btn');

        if (!wanted) {
            btn?.remove();
            continue;
        }
        if (btn) {
            btn.dataset.maKey = key;
            continue;
        }
        const el = document.createElement('div');
        el.className = 'mes_button ma-btn fa-solid fa-images';
        el.title = '이 채팅의 이미지 변경';
        el.dataset.maKey = key;
        mes.querySelector('.extraMesButtons')?.prepend(el);
    }
}

let picker = null;
const closePicker = () => { picker?.remove(); picker = null; };

/** 채팅 이미지 선택창을 연다. */
function openPicker(anchor, key) {
    closePicker();
    const files = cardData(key)?.files ?? [];
    const def = resolve(key, 'list');

    picker = document.createElement('div');
    picker.className = 'ma-picker';

    const shown = resolve(key, 'chat');

    const add = (f, label) => {
        const isDefault = (def ?? null) === f;
        const item = document.createElement('div');
        item.className = 'ma-picker-item' + (shown === f ? ' active' : '');
        item.innerHTML = '<div class="ma-thumb">'
            + `<img src="${f ? imgUrl(key, f) : originalThumbUrl(key)}" alt="">`
            + '<div class="ma-check fa-solid fa-check"></div>'
            + (isDefault ? '<div class="ma-badge">기본</div>' : '')
            + '</div>';
        item.append(Object.assign(document.createElement('span'), { textContent: label }));
        item.title = isDefault ? `${label}\n기본 이미지입니다` : label;

        const thumb = item.querySelector('img');
        if (thumb) markMissing(thumb);

        item.onclick = async () => {
            closePicker();
            await setChatOverride(key, isDefault ? undefined : (f ?? ''));
        };
        picker.append(item);
    };

    add(null, '원본');
    for (const f of files) add(f, f);

    document.body.append(picker);
    const r = anchor.getBoundingClientRect();
    picker.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - picker.offsetWidth - 4))}px`;
    picker.style.top = `${Math.max(4, Math.min(r.bottom + 4, window.innerHeight - picker.offsetHeight - 4))}px`;
}

/** 현재 캐릭터 편집창의 아바타 키. 신규 생성 중이면 null. */
function panelKey() {
    const c = ctx();
    if (c.menuType !== 'character_edit') return null;
    const id = c.characterId;
    return id !== undefined && id !== null ? c.characters[id]?.avatar ?? null : null;
}

/** 터치 또는 좁은 화면 여부. CSS 미디어 쿼리와 같아야 한다. */
const COMPACT_QUERY = '(hover: none), (max-width: 1000px)';
const isCompact = () => matchMedia(COMPACT_QUERY).matches;

/** 길게 눌렀을 때 뒤따르는 클릭을 막고 콜백을 실행한다. */
function bindLongPress(el, onLongPress, { enabled = () => true, threshold = 500 } = {}) {
    let timer = null;
    let fired = false;
    const start = () => {
        if (!enabled()) return;
        fired = false;
        el.classList.add('ma-pressing');
        timer = setTimeout(() => { fired = true; el.classList.remove('ma-pressing'); onLongPress(); }, threshold);
    };
    const cancel = () => { clearTimeout(timer); timer = null; el.classList.remove('ma-pressing'); };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('click', (e) => {
        if (!fired) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        fired = false;
    }, true);
}

function renderStrip() {
    renderPanelStrip('ma', panelKey());
    renderPanelStrip('ma_persona', user_avatar ? personaKey(user_avatar) : null);
}

function renderPanelStrip(prefix, key) {
    const strip = document.getElementById(`${prefix}_strip`);
    const drawer = document.getElementById(`${prefix}_drawer`);
    const count = document.getElementById(`${prefix}_count`);
    if (!strip) return;

    if (drawer) drawer.style.display = key ? '' : 'none';
    if (!key) { strip.innerHTML = ''; return; }

    const { files = [], list = null } = cardData(key) ?? {};
    if (count) count.textContent = files.length ? ` (${files.length})` : '';
    strip.innerHTML = '';

    // 원본 타일로 기본 이미지 선택을 해제할 수 있다.
    const orig = document.createElement('div');
    orig.className = 'ma-tile' + (list === null ? ' selected' : '');
    orig.title = list === null
        ? '원본\n기본 이미지로 쓰는 중.'
        : '원본\n클릭하면 기본 이미지를 원래대로 되돌립니다.';
    orig.innerHTML = `<img src="${originalThumbUrl(key)}">`
        + '<div class="ma-check fa-solid fa-check"></div>';
    orig.querySelector('img').onclick = () => setListImage(key, null);
    markMissing(orig.querySelector('img'));
    strip.append(orig);

    for (const f of files) {
        const tile = document.createElement('div');
        tile.className = 'ma-tile' + (f === list ? ' selected' : '');
        tile.title = f === list
            ? `${f}\n기본 이미지로 쓰는 중.`
            : `${f}\n클릭하면 기본 이미지로 지정합니다.`;

        // 터치 화면에서는 × 대신 길게 눌러 삭제한다.
        tile.innerHTML = `<img src="${imgUrl(key, f)}">`
            + '<div class="ma-check fa-solid fa-check"></div>'
            + '<div class="ma-del fa-solid fa-xmark" title="삭제"></div>';

        markMissing(tile.querySelector('img'));
        tile.querySelector('img').onclick = () => setListImage(key, f);
        tile.querySelector('.ma-del').onclick = (e) => { e.stopPropagation(); deleteImage(key, f); };
        bindLongPress(tile, () => deleteImage(key, f), { enabled: isCompact });
        strip.append(tile);
    }

    const plus = document.createElement('div');
    plus.className = 'ma-tile ma-add fa-solid fa-plus';
    plus.title = '이미지 추가';
    plus.onclick = () => addImage(key);
    strip.append(plus);
}

async function setListImage(key, file) {
    const existing = cardData(key);
    if ((!existing && file === null) || existing?.list === file) return;
    const d = existing ?? { files: [] };
    await writeCard(key, { ...d, list: file });
    renderStrip();
    refresh();
}

const readAsDataUrl = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
});

const loadImage = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
});

/** 자른 이미지를 투명도를 보존한 PNG Base64로 만든다. */
async function cropToPng(dataUrl, crop) {
    const img = await loadImage(dataUrl);
    const w = Math.round(crop?.width || img.naturalWidth);
    const h = Math.round(crop?.height || img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, crop?.x || 0, crop?.y || 0, w, h, 0, 0, w, h);
    return canvas.toDataURL('image/png').split(',')[1];
}

function pickFile() {
    return new Promise((res) => {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
        const finish = file => { input.remove(); res(file); };
        input.hidden = true;
        input.onchange = () => finish(input.files?.[0] ?? null);
        input.oncancel = () => finish(null);
        document.body.append(input);
        input.click();
    });
}

async function addImage(key) {
    if (uploading) return;
    uploading = true;
    try {
        await uploadImage(key);
    } catch (error) {
        console.error('[Multi Avatar] 업로드 실패', error);
        toastr.error('이미지 업로드에 실패했습니다.');
    } finally {
        uploading = false;
    }
}

let uploading = false;

async function uploadImage(key) {
    const file = await pickFile();
    if (!file) return;

    const { Popup, POPUP_TYPE } = ctx();
    const dataUrl = await readAsDataUrl(file);

    let crop;
    if (!ctx().powerUserSettings.never_resize_avatars) {
        const dlg = new Popup('이미지 자르기', POPUP_TYPE.CROP, '', { cropImage: dataUrl });
        if (!await dlg.show()) return;
        crop = dlg.cropData;
    }

    const d = cardData(key) ?? { files: [], list: null };
    const dir = dirOf(key);
    assertPathPart(dir);
    const base = dir.replace(/\./g, '_');

    // 실제 폴더도 확인해 기존 파일을 덮어쓰지 않는다.
    const onDisk = await cleanupRequest('/api/images/list', { folder: dir });
    if (!Array.isArray(onDisk)) throw new Error('이미지 목록 응답이 올바르지 않습니다.');
    const taken = new Set([...(d.files ?? []), ...onDisk]);
    let n = 1;
    while (taken.has(`${base}_add${n}.png`)) n++;

    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({
            image: await cropToPng(dataUrl, crop),
            format: 'png',
            filename: `${base}_add${n}`,
            ch_name: dir,
        }),
    });
    if (!res.ok) return toastr.error('이미지 업로드에 실패했습니다.');

    const saved = (await res.json()).path.split('/').pop();
    await writeCard(key, { ...d, dir, files: [...(d.files ?? []), saved] });
    renderStrip();
    refresh();
}

async function deleteImage(key, file) {
    if (!await ctx().Popup.show.confirm('이미지 삭제', `${file} 을(를) 삭제할까요?`)) return;

    const d = cardData(key) ?? { files: [], list: null };
    await deleteFolder(dirOf(key), [file]);
    probed.clear();

    const files = (d.files ?? []).filter(f => f !== file);
    await writeCard(key, files.length ? {
        ...d,
        files,
        list: d.list === file ? null : d.list,
    } : undefined);

    if (chatOverride(key) === file) {
        await setChatOverride(key, undefined);
    }

    renderStrip();
    refresh();
}

/** 폴더의 지정한 파일만 삭제한다. */
async function deleteFolder(dir, files) {
    assertPathPart(dir);
    for (const file of files ?? []) assertPathPart(file);
    for (const f of files ?? []) {
        const response = await fetch('/api/images/delete', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ path: `${IMG_ROOT}/${dir}/${f}` }),
        });
        if (!response.ok && response.status !== 404) throw new Error(`이미지 삭제 실패: ${f}`);
    }
}

function assertPathPart(value) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..'
        || /[\\/\u0000-\u001f<>:"|?*]/.test(value) || /[. ]$/.test(value)) {
        throw new Error('추가 이미지 경로가 올바르지 않습니다.');
    }
}

/** 캐릭터 카드에 등록된 추가 이미지를 삭제한다. */
function deleteCardImages(char) {
    const d = char?.data?.extensions?.[KEY];
    if (!d?.files?.length) return Promise.resolve();
    const legacy = /^(.*)_add\d+\.[^.]+$/.exec(d.files[0]);
    return deleteFolder(d.dir || (legacy ? `${legacy[1]}.png` : char.avatar), d.files);
}

async function deletePersonaImages(file) {
    const key = personaKey(file);
    const data = cardData(key);
    if (data?.files?.length) await deleteFolder(dirOf(key), data.files);
    await writeCard(key, undefined);
}

async function purgePersonas() {
    for (const file of Object.keys(ctx().extensionSettings[KEY]?.personas ?? {})) {
        await deletePersonaImages(file);
    }
    delete ctx().extensionSettings[KEY];
    ctx().saveSettingsDebounced();
}

async function purgeCards() {
    const c = ctx();
    if (typeof c.constants?.unset !== 'string') throw new Error('카드 데이터 삭제 API를 사용할 수 없습니다.');
    const expected = c.characters.filter(ch => ch?.data?.extensions?.[KEY] !== undefined).map(ch => ch.avatar);
    const result = await c.writeExtensionFieldBulk([], KEY, c.constants.unset);
    if (!result || result.failed?.length || expected.some(avatar => !result.updated?.includes(avatar))) {
        throw new Error('일부 캐릭터 카드 데이터를 삭제하지 못했습니다.');
    }
}

/** 채팅 헤더에서 선택한 종류의 이미지 설정만 제거한다. */
function stripMeta(chat, scope = 'all') {
    const meta = Array.isArray(chat) && chat[0]?.chat_metadata;
    if (!meta || !(KEY in meta)) return false;
    if (scope === 'all') {
        delete meta[KEY];
        return true;
    }
    let changed = false;
    for (const key of Object.keys(meta[KEY] ?? {})) {
        if (isPersona(key) !== (scope === 'persona')) continue;
        delete meta[KEY][key];
        changed = true;
    }
    if (changed && !Object.keys(meta[KEY]).length) delete meta[KEY];
    return changed;
}

// 정리 중 요청 실패를 호출자에게 전달한다.
async function cleanupRequest(url, body) {
    const response = await fetch(url, {
        method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`정리 요청 실패: ${url} (${response.status})`);
    return response.json().catch(() => null);
}

/** 선택한 종류의 이미지, 설정, 채팅 선택 정보를 정리한다. */
async function purgeAll(log, scope = 'all') {
    const c = ctx();
    if (uploading) throw new Error('이미지 업로드가 끝난 뒤 정리해 주세요.');
    if (scope !== 'persona' && typeof c.constants?.unset !== 'string') {
        throw new Error('카드 데이터 삭제 API를 사용할 수 없습니다.');
    }
    // 지연 로드된 카드도 먼저 읽어 파일 목록을 놓치지 않는다.
    if (scope !== 'persona') {
        for (let id = 0; id < c.characters.length; id++) {
            if (!ctx().characters[id]?.shallow) continue;
            await c.unshallowCharacter(id);
            if (ctx().characters[id]?.shallow) throw new Error('캐릭터 데이터를 불러오지 못했습니다.');
        }
    }
    const chars = ctx().characters ?? [];

    log('이미지 파일 삭제 중...');
    if (scope !== 'persona') {
        for (const ch of chars) await deleteCardImages(ch);
    }
    if (scope !== 'character') await purgePersonas();

    if (scope !== 'persona') {
        log('캐릭터 카드 정리 중...');
        await purgeCards();
    }

    let done = 0;
    for (const ch of chars) {
        log(`채팅 정리 중... (${++done}/${chars.length})`);
        const list = await cleanupRequest('/api/characters/chats', { avatar_url: ch.avatar, simple: true });
        if (!Array.isArray(list)) continue;

        for (const { file_id } of list) {
            const chat = await cleanupRequest('/api/chats/get', { avatar_url: ch.avatar, file_name: file_id });
            if (stripMeta(chat, scope)) {
                await cleanupRequest('/api/chats/save', { avatar_url: ch.avatar, file_name: file_id, chat, force: true });
            }
        }
    }

    log('그룹 채팅 정리 중...');
    const groups = await cleanupRequest('/api/groups/all', {}) ?? [];
    for (const g of groups) {
        for (const id of g?.chats ?? []) {
            const chat = await cleanupRequest('/api/chats/group/get', { id });
            if (stripMeta(chat, scope)) {
                await cleanupRequest('/api/chats/group/save', { id, chat, force: true });
            }
        }
    }

    const current = { chat_metadata: { [KEY]: { ...(c.chatMetadata?.[KEY] ?? {}) } } };
    if (stripMeta([current], scope)) {
        replaceChatMap(current.chat_metadata[KEY] ?? {});
        await c.saveMetadata();
    }
    probed.clear();
    closePicker();

    log(scope === 'all' ? '모든 데이터 정리가 완료되었습니다.'
        : `${scope === 'persona' ? '페르소나' : '캐릭터'} 추가 이미지와 관련 설정 정리가 완료되었습니다.`);
}

/** 확장 삭제 시에도 채팅 선택 정보를 포함해 동일하게 정리한다. */
export async function cleanUp() {
    await purgeAll(() => {});
}

function addSettings() {
    const html = `
    <div class="multi-avatar-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Multi Avatar</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small>추가 이미지와 관련 설정을 전체 또는 종류별로 정리합니다. 원본 프로필 이미지는 유지됩니다.</small>
                <hr>
                <div class="flex-container">
                    <button type="button" class="menu_button menu_button_icon" id="ma_purge">
                        <i class="fa-solid fa-broom"></i><span>모든 데이터 정리</span>
                    </button>
                    <button type="button" class="menu_button menu_button_icon" id="ma_purge_persona">
                        <i class="fa-solid fa-user"></i><span>페르소나 이미지 정리</span>
                    </button>
                    <button type="button" class="menu_button menu_button_icon" id="ma_purge_character">
                        <i class="fa-solid fa-address-card"></i><span>캐릭터 이미지 정리</span>
                    </button>
                </div>
                <div id="ma_purge_status" class="ma-status"></div>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);

    const actions = [
        ['ma_purge', 'all', '모든 데이터 정리', '모든'],
        ['ma_purge_persona', 'persona', '페르소나 이미지 정리', '페르소나의'],
        ['ma_purge_character', 'character', '캐릭터 이미지 정리', '캐릭터의'],
    ];
    for (const [id, scope, title, target] of actions) document.getElementById(id).onclick = async () => {
        const chars = scope === 'persona' ? [] : ctx().characters ?? [];
        const personas = scope === 'character' ? [] : Object.values(ctx().extensionSettings[KEY]?.personas ?? {});
        const total = chars.reduce((n, x) => n + (x?.data?.extensions?.[KEY]?.files?.length ?? 0), 0)
            + personas.reduce((n, x) => n + (x.files?.length ?? 0), 0);
        const buttons = actions.map(([buttonId]) => document.getElementById(buttonId));
        const status = document.getElementById('ma_purge_status');
        buttons.forEach(button => button.disabled = true);
        try {
            const ok = await ctx().Popup.show.confirm(title,
                `${target} 추가 이미지 [${total}장]과 설정이 <b>영구 삭제</b>됩니다.`
                + '<br>원본 프로필 이미지는 유지됩니다.'
                + (scope === 'all' ? '' : `<br>${scope === 'persona' ? '캐릭터' : '페르소나'}는 삭제되지 않습니다.`)
                + '<br>되돌릴 수 없습니다.');
            if (!ok) return;
            await purgeAll(msg => status.textContent = msg, scope);
        } catch (e) {
            console.error('[Multi Avatar] 정리 실패', e);
            status.textContent = '정리 중 오류가 발생했습니다. 일부 항목만 정리되었을 수 있습니다. 콘솔을 확인하세요.';
        } finally {
            probed.clear();
            refresh();
            renderStrip();
            buttons.forEach(button => button.disabled = false);
        }
    };
}

function addImageDrawer(anchor, prefix) {
    anchor?.insertAdjacentHTML('afterend', `
        <div id="${prefix}_drawer" class="inline-drawer flex-container flexFlowColumn flexNoGap" style="display:none">
            <div class="inline-drawer-toggle inline-drawer-header padding0 gap5px standoutHeader">
                <div class="title_restorable flexGap5 wide100p">
                    <span class="flex1">추가 이미지<span id="${prefix}_count" class="ma-count"></span></span>
                </div>
                <div class="flex-container widthFitContent">
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable"></div>
                </div>
            </div>
            <div class="inline-drawer-content">
                <div id="${prefix}_strip" class="ma-strip"></div>
            </div>
        </div>`);
}

jQuery(async () => {
    const { eventSource, event_types } = ctx();

    addSettings();
    addImageDrawer(document.getElementById('avatar_div'), 'ma');
    addImageDrawer(document.querySelector('.persona_management_global_settings'), 'ma_persona');

    // 미리보기 src 변경으로 캐릭터 전환을 감지한다.
    const preview = document.getElementById('avatar_load_preview');
    if (preview) {
        new MutationObserver(() => {
            renderStrip();
            swap(document.getElementById('avatar_div'), 'list');
        }).observe(preview, { attributes: true, attributeFilter: ['src'] });
    }

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => swap(document.getElementById('rm_print_characters_block'), 'list'));
    for (const e of [event_types.CHAT_CHANGED, event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_UPDATED]) {
        eventSource.on(e, () => {
            closePicker();
            const chat = document.getElementById('chat');
            swap(chat, 'chat');
            syncMesButtons(chat);
        });
    }
    eventSource.on(event_types.CHARACTER_EDITED, () => { refresh(); renderStrip(); });
    for (const event of [event_types.PERSONA_CHANGED, event_types.PERSONA_CREATED,
        event_types.PERSONA_UPDATED, event_types.PERSONA_RENAMED]) {
        if (event) eventSource.on(event, () => { closePicker(); refresh(); renderStrip(); });
    }
    if (event_types.PERSONA_DELETED) eventSource.on(event_types.PERSONA_DELETED, async ({ avatarId }) => {
        await deletePersonaImages(avatarId);
        if (chatOverride(personaKey(avatarId)) !== undefined) await setChatOverride(personaKey(avatarId), undefined);
        probed.clear();
        closePicker();
        refresh();
        renderStrip();
    });

    eventSource.on(event_types.CHARACTER_DELETED, ({ character }) => deleteCardImages(character));

    eventSource.on(event_types.CHARACTER_DUPLICATED, async ({ newAvatar }) => {
        await ctx().getCharacters();
        if (cardData(newAvatar)) await writeCard(newAvatar, undefined);
    });

    // 구버전 데이터는 이름 변경 전 키를 폴더명으로 보존한다.
    eventSource.on(event_types.CHARACTER_RENAMED, async (oldAvatar, newAvatar) => {
        resetMarks();
        const d = cardData(oldAvatar);
        if (!d?.files?.length || d.dir) return;
        await ctx().writeExtensionFieldBulk([newAvatar], KEY, { ...d, dir: oldAvatar });
    });

    // 이벤트를 놓치는 렌더 경로를 보완한다.
    for (const [id, mode] of [['rm_print_characters_block', 'list'], ['user_avatar_block', 'list'], ['chat', 'chat']]) {
        const el = document.getElementById(id);
        if (!el) continue;
        new MutationObserver((records) => {
            for (const r of records) {
                for (const node of r.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    swap(node, mode);
                    if (mode === 'chat') syncMesButtons(node);
                }
            }
            if (id === 'user_avatar_block') renderStrip();
        }).observe(el, { childList: true, subtree: id === 'user_avatar_block' });
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.ma-btn');
        if (btn) return openPicker(btn, btn.dataset.maKey);
        if (!e.target.closest?.('.ma-picker')) closePicker();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePicker(); });

    // 실리태번이 만든 확대창의 추가 이미지 경로를 바로잡는다.
    document.addEventListener('click', (e) => {
        const img = e.target.closest?.('#chat .mes .avatar')?.querySelector('img');
        const src = img?.getAttribute('src');
        if (!src || !img.dataset.maKey || sameUrl(src, img.dataset.maOrig)) return;

        const charname = src.substring(src.lastIndexOf('=') + 1).replace('.png', '');
        for (const z of document.querySelectorAll('body > .zoomed_avatar')) {
            if (z.getAttribute('forChar') !== charname) continue;
            const zi = z.querySelector('img');
            if (!zi) continue;
            zi.src = src;
            zi.dataset.izoomifyUrl = src;
        }
    });

    refresh();
    renderStrip();
});
