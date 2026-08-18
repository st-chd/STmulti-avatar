/**
 * Multi Avatar - 캐릭터 하나에 여러 이미지를 두고 목록/채팅에서 각각 다르게 표시.
 *
 * 저장 구조
 *   카드   : data.extensions.multiAvatar = { dir: '폴더명', files: [...], list: '파일명'|null }
 *   채팅방 : chat_metadata.multiAvatar   = { '<아바타키>': '파일명' | '' }   ('' = 원본 강제)
 *   이미지 : user/images/<dir>/<파일명>
 *
 * dir은 첫 업로드 때 아바타키로 정하고 이후 절대 바꾸지 않는다. 캐릭터 이름을 바꾸면
 * 아바타키가 새로 발급되는데(characters.js의 /rename), dir을 카드가 들고 다니므로
 * 이미지를 옮기지 않아도 그대로 찾아진다.
 *
 * 표시 우선순위
 *   목록 : 카드 list -> 원본
 *   채팅 : 방 오버라이드 -> 카드 list -> 원본
 */

const KEY = 'multiAvatar';
const IMG_ROOT = 'user/images';

const ctx = () => SillyTavern.getContext();

// ─── 저장소 읽기/쓰기 ────────────────────────────────────────────────

const charIndex = (key) => ctx().characters.findIndex(c => c?.avatar === key);

function cardData(key) {
    const c = ctx().characters.find(x => x?.avatar === key);
    return c?.data?.extensions?.[KEY] ?? null;
}

async function writeCard(key, data) {
    const id = charIndex(key);
    if (id < 0) return;
    await ctx().writeExtensionField(id, KEY, data);
}

/** 이 채팅방의 오버라이드. undefined = 미설정, '' = 원본 강제 */
const chatOverride = (key) => ctx().chatMetadata?.[KEY]?.[key];

async function setChatOverride(key, value) {
    const c = ctx();
    const map = { ...(c.chatMetadata?.[KEY] ?? {}) };
    if (value === undefined) delete map[key];
    else map[key] = value;
    c.updateChatMetadata({ [KEY]: map });
    await c.saveMetadata();
    refresh();
}

/**
 * 최종적으로 보여줄 파일명. null이면 원본 아바타.
 * 이미 삭제된 파일을 가리키는 설정은 무시한다. 다른 채팅방에 남은 참조까지
 * 한꺼번에 무효화되므로 삭제 시 방들을 일일이 찾아다닐 필요가 없다.
 */
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

/**
 * 이 캐릭터의 이미지 폴더명.
 * dir이 없는 예전 데이터는 파일명에서 역산한다. 파일명이 '<폴더명>_add<n>.png'
 * 규칙이라, 이름 변경으로 아바타키가 바뀐 카드도 원래 폴더를 되찾을 수 있다.
 */
function dirOf(key) {
    const d = cardData(key);
    if (d?.dir) return d.dir;
    const m = /^(.*)_add\d+\.[^.]+$/.exec(d?.files?.[0] ?? '');
    return m ? `${m[1]}.png` : key;
}

// 반드시 절대경로(선행 슬래시)로 만든다. Moonlit Echoes Theme가 src를 절대경로로
// 정규화해서 되쓰는데, 상대경로를 쓰면 표기가 달라져 서로 무한히 덮어쓰게 된다.
const imgUrl = (key, file) => `/${IMG_ROOT}/${encodeURIComponent(dirOf(key))}/${encodeURIComponent(file)}`;

/** 같은 리소스를 가리키는 URL인지. 상대/절대, origin 포함 여부를 무시하고 비교한다 */
function sameUrl(a, b) {
    if (!a || !b) return false;
    const norm = (u) => {
        try { return new URL(u, location.origin).pathname + new URL(u, location.origin).search; }
        catch { return u; }
    };
    return norm(a) === norm(b);
}

/** 캐릭터의 진짜 원본 아바타 썸네일. ST가 쓰는 것과 같은 경로다 */
const originalThumbUrl = (key) => `/thumbnail?type=avatar&file=${encodeURIComponent(key)}`;

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

// ─── 이미지 교체 ─────────────────────────────────────────────────────

/** /thumbnail?type=avatar&file=... 에서 아바타키 추출 */
function avatarKeyOf(src) {
    const m = /thumbnail\?type=avatar&file=([^&"']+)/.exec(src || '');
    return m ? decodeURIComponent(m[1]) : null;
}

/**
 * URL이 실제로 로드되는지 미리 확인한다.
 * ST는 .avatar img의 error에서 <img>를 통째로 지우고 'missing-avatar'로 바꾸기 때문에
 * (script.js의 addOneMessage), 없는 파일을 넣으면 아바타가 영구히 사라진다.
 */
const probed = new Map(); // URL -> Promise<boolean>
function probe(url) {
    if (probed.has(url)) return probed.get(url);

    const p = new Promise((res) => {
        const t = new Image();
        t.onload = () => res(true);
        t.onerror = () => res(false);
        t.src = url;
    });
    // 성공은 캐시해서 재확인을 피하지만, 실패는 캐시하지 않는다. 업로드 도중처럼
    // 일시적으로 없던 파일이 나중에 생겨도 다음 시도에서 다시 확인할 수 있어야 한다.
    p.then((ok) => { if (!ok) probed.delete(url); });
    probed.set(url, p);
    return p;
}

/**
 * Moonlit Echoes Theme는 메시지 배경의 큰 아바타를 CSS 변수로 그리는데,
 * 그 값을 childList 변화에서만 갱신해 src 교체를 놓친다. 우리가 직접 맞춰준다.
 * (테마가 이미 심어둔 값이 있을 때만 건드린다)
 */
function syncThemeVars(img, thumb, original = thumb) {
    const mes = img.closest('.mes');
    if (!mes || mes.dataset.avatar === undefined) return;

    const abs = (u) => (u.startsWith('/') ? u : `/${u}`);
    const t = abs(thumb);
    const o = abs(original);

    mes.dataset.avatarThumb = t;
    mes.dataset.avatarOriginal = o;
    mes.dataset.avatar = t;
    mes.style.setProperty('--mes-avatar-thumb-url', `url('${t}')`);
    mes.style.setProperty('--mes-avatar-original-url', `url('${o}')`);
    mes.style.setProperty('--mes-avatar-url', `url('${t}')`);
}

/**
 * root 안의 아바타 이미지를 mode('list'|'chat') 기준으로 교체.
 * "이미 적용됐는지"는 항상 img의 실제 src와 비교한다 — 별도 플래그로 기억하면,
 * avatar_load_preview처럼 SillyTavern이 나중에 src를 원본으로 되돌리는 요소에서
 * 플래그만 낡은 채로 남아 재적용을 영영 안 하게 될 수 있다.
 */
function swap(root, mode) {
    if (!root) return;
    for (const img of root.querySelectorAll('img')) {
        // 원본 URL이 보이면 항상 그쪽을 신뢰한다. 캐시만 믿으면 이름 변경으로
        // 아바타키가 바뀌었을 때 옛 키를 계속 가리킨다.
        const fromSrc = avatarKeyOf(img.getAttribute('src'));
        const key = fromSrc ?? img.dataset.maKey;
        if (!key) continue;

        if (fromSrc && img.dataset.maKey !== fromSrc) {
            img.dataset.maKey = fromSrc;
            img.dataset.maOrig = img.getAttribute('src');
        }

        const file = resolve(key, mode);
        const wantUrl = file ? imgUrl(key, file) : img.dataset.maOrig;
        if (sameUrl(img.getAttribute('src'), wantUrl)) continue; // 테마가 표기를 바꿔놨을 수 있어 정규화 비교

        if (!file) {
            img.src = img.dataset.maOrig;
            // 원본 복귀 시엔 테마가 쓰던 썸네일/원본 구분을 그대로 되살린다
            syncThemeVars(img, img.dataset.maOrig, `characters/${key}`);
            continue;
        }

        // 로드에 성공한 뒤에만 갈아끼운다. 실패하면 원본을 그대로 둔다.
        probe(wantUrl).then((ok) => {
            // 그 사이 원하는 게 바뀌었거나, 다른 경로로 이미 반영됐다면 그만둔다
            if (resolve(key, mode) !== file || sameUrl(img.getAttribute('src'), wantUrl)) return;
            if (ok) {
                img.src = wantUrl;
                syncThemeVars(img, wantUrl);
            } else {
                // 파일이 없어졌다면 원본을 보여준다
                img.src = img.dataset.maOrig;
                syncThemeVars(img, img.dataset.maOrig, `characters/${key}`);
            }
        });
    }
}

// 표식을 지워 다음 렌더 때 아바타키를 다시 읽게 한다. 이미 교체된 이미지는
// 원본 URL이 안 남아 있어 키를 스스로 재확인할 수 없기 때문.
function resetMarks() {
    for (const img of document.querySelectorAll('img[data-ma-key]')) {
        if (img.dataset.maOrig) img.src = img.dataset.maOrig;
        delete img.dataset.maKey;
        delete img.dataset.maOrig;
    }
}

// 목록·채팅 이미지와 채팅 버튼을 현재 설정에 맞게 갱신. 캐릭터창의 큰 아바타
// (avatar_div)도 '목록 이미지'와 같은 규칙을 따른다 — 선택했을 때 목록과 같은
// 이미지가 보여야 자연스럽다.
function refresh() {
    swap(document.getElementById('rm_print_characters_block'), 'list');
    swap(document.getElementById('avatar_div'), 'list');
    const chat = document.getElementById('chat');
    swap(chat, 'chat');
    syncMesButtons(chat);
}

// ─── 채팅 메시지의 이미지 변경 버튼 ──────────────────────────────────

/** 추가 이미지가 있는 메시지에만 버튼이 있도록 맞춘다 (추가/삭제 양방향) */
function syncMesButtons(root) {
    if (!root) return;
    // root 자신이 메시지일 수도, 메시지들의 부모일 수도 있음
    const list = root.matches?.('.mes') ? [root] : root.querySelectorAll('.mes');
    for (const mes of list) {
        const key = mes.querySelector('.avatar img')?.dataset.maKey;
        const wanted = !!key && !!cardData(key)?.files?.length;
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
        mes.querySelector('.extraMesButtons')?.prepend(el); // ... 메뉴 안에 배치
    }
}

let picker = null;
const closePicker = () => { picker?.remove(); picker = null; };

/** 버튼 아래에 썸네일 드롭다운 열기 */
function openPicker(anchor, key) {
    closePicker();
    const files = cardData(key)?.files ?? [];
    const def = cardData(key)?.list ?? null; // 캐릭터 기본값 (없으면 원본과 같음)
    const cur = chatOverride(key);

    picker = document.createElement('div');
    picker.className = 'ma-picker';

    // 지금 실제로 보이는 것. null이면 원본
    const shown = cur === undefined ? def : (cur === '' ? null : cur);

    /** @param {string|null} f 파일명, null이면 원본 */
    const add = (f, label) => {
        const isDefault = (def ?? null) === f;
        const item = document.createElement('div');
        item.className = 'ma-picker-item' + (shown === f ? ' active' : '');
        // 체크·배지는 썸네일 기준으로 붙어야 파일명 높이에 휘둘리지 않는다
        item.innerHTML = '<div class="ma-thumb">'
            + (f ? `<img src="${imgUrl(key, f)}">` : '<div class="ma-picker-none"><i class="fa-solid fa-user"></i></div>')
            + '<div class="ma-check fa-solid fa-check"></div>'
            + (isDefault ? '<div class="ma-badge">기본</div>' : '')
            + '</div>';
        item.append(Object.assign(document.createElement('span'), { textContent: label }));
        item.title = isDefault ? `${label}\n캐릭터 기본값입니다` : label;

        const thumb = item.querySelector('img');
        if (thumb) markMissing(thumb);

        // 기본값을 고르는 건 '설정 해제'와 결과가 같다. 쓸데없는 설정을 남기지 않는다.
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
    picker.style.top = `${r.bottom + 4}px`;
    picker.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - picker.offsetWidth - 4))}px`;
}

// ─── 캐릭터창 필름스트립 ─────────────────────────────────────────────

/** 현재 캐릭터창에 열려 있는 캐릭터의 아바타키 (신규 생성 중이면 null) */
function panelKey() {
    const c = ctx();
    if (c.menuType !== 'character_edit') return null;
    const id = c.characterId;
    return id !== undefined && id !== null ? c.characters[id]?.avatar ?? null : null;
}

/** 압축(모바일) 모드 판정. style.css의 미디어 쿼리와 반드시 같은 조건이어야 한다 */
const COMPACT_QUERY = '(hover: none), (max-width: 1000px)';
const isCompact = () => matchMedia(COMPACT_QUERY).matches;

/**
 * 요소를 꾹 누르면 onLongPress를 호출한다. 길게 눌렀다면 뒤따라오는 클릭은
 * 삼켜서, 삭제하려던 손가락이 그대로 이미지 선택으로 이어지지 않게 한다.
 */
function bindLongPress(el, onLongPress, { enabled = () => true, threshold = 500 } = {}) {
    let timer = null;
    let fired = false;
    const start = () => {
        if (!enabled()) return; // 데스크톱에서는 꾹 눌러도 아무 일 없어야 한다
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
        e.stopImmediatePropagation(); // 같은 요소의 선택(onclick) 핸들러도 막는다
        fired = false;
    }, true);
}

function renderStrip() {
    const strip = document.getElementById('ma_strip');
    const drawer = document.getElementById('ma_drawer');
    const count = document.getElementById('ma_count');
    if (!strip) return;

    const key = panelKey();
    // 신규 캐릭터 생성 중에는 섹션 자체를 감춘다
    if (drawer) drawer.style.display = key ? '' : 'none';
    if (!key) { strip.innerHTML = ''; return; }

    const { files = [], list = null } = cardData(key) ?? {};
    if (count) count.textContent = files.length ? ` (${files.length})` : '';
    strip.innerHTML = '';

    // 원본 타일을 항상 맨 앞에 둔다. 목록 이미지를 지정하지 않은 상태를
    // 고를 수 있는 명시적인 자리가 없으면, 해제하려면 선택된 타일을 다시
    // 눌러야 하는데 눈에 잘 안 띈다.
    const orig = document.createElement('div');
    orig.className = 'ma-tile' + (list === null ? ' selected' : '');
    orig.title = list === null
        ? '원본\n캐릭터 목록에 쓰는 중.'
        : '원본\n클릭하면 캐릭터 목록 이미지를 원래대로 되돌립니다.';
    orig.innerHTML = `<img src="${originalThumbUrl(key)}">`
        + '<div class="ma-check fa-solid fa-check"></div>';
    orig.querySelector('img').onclick = () => setListImage(key, null);
    strip.append(orig);

    for (const f of files) {
        const tile = document.createElement('div');
        tile.className = 'ma-tile' + (f === list ? ' selected' : '');
        tile.title = f === list
            ? `${f}\n캐릭터 목록에 쓰는 중.`
            : `${f}\n클릭하면 캐릭터 목록 이미지로 지정합니다.`;

        // 모바일은 × 를 누르다 실수로 삭제하기 쉬워 꾹 누르기로 대체한다. 둘 다
        // 항상 만들어두고, × 는 CSS 미디어 쿼리로 숨기고 꾹 누르기는 누르는 순간
        // 판정한다 — 그래야 창 폭이 바뀌어도 다시 그리지 않고 즉시 따라간다.
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
    const d = cardData(key) ?? { files: [] };
    await writeCard(key, { ...d, list: file });
    renderStrip();
    refresh();
}

// ─── 이미지 추가/삭제 ────────────────────────────────────────────────

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

/** 크롭 영역을 PNG base64로 (투명도 유지) */
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
        input.onchange = () => res(input.files?.[0] ?? null);
        input.click();
    });
}

async function addImage(key) {
    const file = await pickFile();
    if (!file) return;

    const { Popup, POPUP_TYPE } = ctx();
    const dataUrl = await readAsDataUrl(file);

    // 기본 아바타 업로드와 동일한 2:3 크롭 팝업 재사용
    const dlg = new Popup('이미지 자르기', POPUP_TYPE.CROP, '', { cropImage: dataUrl });
    if (!await dlg.show()) return;

    const d = cardData(key) ?? { files: [], list: null };
    const dir = dirOf(key);        // 폴더는 첫 업로드 때 정해지고 이후 고정
    const base = dir.replace(/\.[^.]+$/, '').replace(/\./g, '_');

    // 카드 목록이 아니라 실제 폴더를 기준으로 번호를 매겨야 예전 캐릭터가
    // 남긴 동명 파일을 덮어쓰지 않는다 (어차피 곧 쓸 폴더라 생성돼도 무방)
    const onDisk = await post('/api/images/list', { folder: dir }) ?? [];
    const taken = new Set([...(d.files ?? []), ...onDisk]);
    let n = 1;
    while (taken.has(`${base}_add${n}.png`)) n++;

    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({
            image: await cropToPng(dataUrl, dlg.cropData),
            format: 'png',
            filename: `${base}_add${n}`,
            ch_name: dir,
        }),
    });
    if (!res.ok) return toastr.error('이미지 업로드에 실패했습니다.');

    const saved = (await res.json()).path.split('/').pop();
    await writeCard(key, { ...d, dir, files: [...(d.files ?? []), saved] });
    renderStrip();
    refresh(); // 첫 이미지라면 열려 있는 채팅에 버튼이 새로 생겨야 함
}

async function deleteImage(key, file) {
    if (!await ctx().Popup.show.confirm('이미지 삭제', `${file} 을(를) 삭제할까요?`)) return;

    const d = cardData(key) ?? { files: [], list: null };
    await deleteFolder(dirOf(key), [file]);
    probed.clear(); // 방금 지운 파일의 '성공' 캐시가 남아있으면 유령 이미지로 보일 수 있다

    await writeCard(key, {
        ...d,
        files: (d.files ?? []).filter(f => f !== file),
        list: d.list === file ? null : d.list, // 목록 이미지였다면 해제
    });

    // 지금 열려 있는 방이 이 파일을 쓰고 있었다면 설정도 함께 정리
    // (다른 방들은 resolve()가 알아서 무시한다)
    if (chatOverride(key) === file) {
        await setChatOverride(key, undefined);
    }

    renderStrip();
    refresh();
}

/** 폴더 안의 지정한 파일들을 삭제 (카드 필드는 건드리지 않음) */
async function deleteFolder(dir, files) {
    await Promise.all((files ?? []).map(f => fetch('/api/images/delete', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ path: `${IMG_ROOT}/${dir}/${f}` }),
    }).catch(() => { })));
}

/** 카드에서 폴더/파일 목록을 뽑아 이미지 삭제 */
function deleteCardImages(char) {
    const d = char?.data?.extensions?.[KEY];
    if (!d?.files?.length) return Promise.resolve();
    return deleteFolder(dirOf(char.avatar), d.files);
}

// ─── 전체 정리 ───────────────────────────────────────────────────────

const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: ctx().getRequestHeaders(),
    body: JSON.stringify(body),
}).then(r => r.ok ? r.json().catch(() => null) : null);

/** 채팅 배열의 헤더에서 우리 메타데이터 제거. 지웠으면 true */
function stripMeta(chat) {
    const meta = Array.isArray(chat) && chat[0]?.chat_metadata;
    if (!meta || !(KEY in meta)) return false;
    delete meta[KEY];
    return true;
}

/**
 * 이미지 파일 + 카드 필드 + 모든 채팅의 chat_metadata까지 완전 제거.
 * @param {(msg: string) => void} log 진행 상황 콜백
 */
async function purgeAll(log) {
    const c = ctx();
    const chars = c.characters ?? [];

    // 1) 이미지 파일
    log('이미지 파일 삭제 중...');
    for (const ch of chars) await deleteCardImages(ch);

    // 2) 캐릭터 카드 필드 (한 번의 요청으로 일괄 처리)
    log('캐릭터 카드 정리 중...');
    await c.writeExtensionFieldBulk([], KEY, c.unset);

    // 3) 캐릭터 채팅
    let done = 0;
    for (const ch of chars) {
        log(`채팅 정리 중... (${++done}/${chars.length})`);
        const list = await post('/api/characters/chats', { avatar_url: ch.avatar, simple: true });
        if (!Array.isArray(list)) continue;

        for (const { file_id } of list) {
            const chat = await post('/api/chats/get', { avatar_url: ch.avatar, file_name: file_id });
            if (stripMeta(chat)) {
                await post('/api/chats/save', { avatar_url: ch.avatar, file_name: file_id, chat, force: true });
            }
        }
    }

    // 4) 그룹 채팅
    log('그룹 채팅 정리 중...');
    const groups = await post('/api/groups/all', {}) ?? [];
    for (const g of groups) {
        for (const id of g?.chats ?? []) {
            const chat = await post('/api/chats/group/get', { id });
            if (stripMeta(chat)) {
                await post('/api/chats/group/save', { id, chat, force: true });
            }
        }
    }

    log('완료되었습니다. 이제 확장을 삭제해도 찌꺼기가 남지 않습니다.');
}

/** 확장 삭제 시 호출되는 clean 훅 (5초 제한이 있어 빠른 항목만 처리) */
export async function cleanUp() {
    const c = ctx();
    for (const ch of c.characters ?? []) await deleteCardImages(ch);
    await c.writeExtensionFieldBulk([], KEY, c.unset);
}

// ─── 설정 패널 ───────────────────────────────────────────────────────

function addSettings() {
    const html = `
    <div class="multi-avatar-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Multi Avatar</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small>캐릭터창의 아바타 아래에서 이미지를 추가하고, 채팅 메시지의
                <i class="fa-solid fa-images"></i> 버튼으로 그 방의 이미지를 바꿉니다.</small>
                <hr>
                <div class="menu_button menu_button_icon" id="ma_purge">
                    <i class="fa-solid fa-broom"></i><span>모든 데이터 정리</span>
                </div>
                <small>이미지 파일, 캐릭터 카드, 모든 채팅 기록의 흔적까지 전부 제거합니다.
                확장을 삭제하기 <b>전에</b> 실행하세요.</small>
                <div id="ma_purge_status" class="ma-status"></div>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);

    document.getElementById('ma_purge').onclick = async () => {
        const chars = (ctx().characters ?? []).filter(x => x?.data?.extensions?.[KEY]?.files?.length);
        const total = chars.reduce((n, x) => n + x.data.extensions[KEY].files.length, 0);

        if (!total) {
            document.getElementById('ma_purge_status').textContent = '정리할 데이터가 없습니다.';
            return;
        }

        const ok = await ctx().Popup.show.confirm('모든 데이터 정리',
            `캐릭터 ${chars.length}명의 추가 이미지 ${total}장이 <b>영구 삭제</b>되고 모든 설정이 사라집니다.`
            + '<br>되돌릴 수 없습니다. 확장을 삭제할 때만 사용하세요.');
        if (!ok) return;

        const status = document.getElementById('ma_purge_status');
        try {
            await purgeAll(msg => status.textContent = msg);
            refresh();
            renderStrip();
        } catch (e) {
            console.error('[Multi Avatar] 정리 실패', e);
            status.textContent = '정리 중 오류가 발생했습니다. 콘솔을 확인하세요.';
        }
    };
}

// ─── 초기화 ──────────────────────────────────────────────────────────

jQuery(async () => {
    const { eventSource, event_types } = ctx();

    addSettings();

    // 캐릭터창 아바타 아래에 접이식 섹션으로 필름스트립을 넣는다. ST 기본
    // inline-drawer를 그대로 써서 여닫기·애니메이션은 코어가 처리한다.
    document.getElementById('avatar_div')?.insertAdjacentHTML('afterend', `
        <div id="ma_drawer" class="inline-drawer flex-container flexFlowColumn flexNoGap" style="display:none">
            <div class="inline-drawer-toggle inline-drawer-header padding0 gap5px standoutHeader">
                <div class="title_restorable flexGap5 wide100p">
                    <span class="flex1">추가 이미지<span id="ma_count" class="ma-count"></span></span>
                </div>
                <div class="flex-container widthFitContent">
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable"></div>
                </div>
            </div>
            <div class="inline-drawer-content">
                <div id="ma_strip" class="ma-strip"></div>
            </div>
        </div>`);

    // 캐릭터창은 전용 이벤트가 없어, 아바타 미리보기의 src 변경으로 전환을 감지.
    // ST가 원본 아바타 src를 심은 직후 우리가 다시 목록 이미지로 덮어써야 하므로
    // 필름스트립을 다시 그리는 것과 같은 타이밍에 큰 아바타도 함께 맞춘다.
    const preview = document.getElementById('avatar_load_preview');
    if (preview) {
        new MutationObserver(() => {
            renderStrip();
            swap(document.getElementById('avatar_div'), 'list');
        }).observe(preview, { attributes: true, attributeFilter: ['src'] });
    }

    // 렌더 직후 교체 (이벤트를 놓치는 경로는 아래 옵저버가 보완)
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => swap(document.getElementById('rm_print_characters_block'), 'list'));
    for (const e of [event_types.CHAT_CHANGED, event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_UPDATED]) {
        eventSource.on(e, () => {
            const chat = document.getElementById('chat');
            swap(chat, 'chat');
            syncMesButtons(chat);
        });
    }
    eventSource.on(event_types.CHARACTER_EDITED, () => { refresh(); renderStrip(); });

    // 캐릭터 삭제 시 이미지도 함께 정리
    eventSource.on(event_types.CHARACTER_DELETED, ({ character }) => deleteCardImages(character));

    // 복제본은 이미지를 물려받지 않으므로 매핑을 비움
    eventSource.on(event_types.CHARACTER_DUPLICATED, async ({ newAvatar }) => {
        await ctx().getCharacters();
        if (cardData(newAvatar)) await writeCard(newAvatar, { files: [], list: null });
    });

    // 이름을 바꾸면 아바타키가 새로 발급된다. dir이 없던 예전 데이터는 여기서
    // 옛 키를 폴더명으로 못박아, 이미지를 옮기지 않고도 계속 찾게 만든다.
    eventSource.on(event_types.CHARACTER_RENAMED, async (oldAvatar, newAvatar) => {
        resetMarks(); // 옛 키에 물린 표식을 떼어낸다
        const d = cardData(oldAvatar);
        if (!d?.files?.length || d.dir) return;
        // 아직 characters 배열에 새 항목이 없으므로 아바타명으로 직접 쓴다
        await ctx().writeExtensionFieldBulk([newAvatar], KEY, { ...d, dir: oldAvatar });
    });

    // 이벤트를 놓치는 경로 보완. 직속 자식만 보므로 스트리밍 중에는 동작하지 않음
    for (const [id, mode] of [['rm_print_characters_block', 'list'], ['chat', 'chat']]) {
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
        }).observe(el, { childList: true });
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.ma-btn');
        if (btn) return openPicker(btn, btn.dataset.maKey);
        if (!e.target.closest?.('.ma-picker')) closePicker();
    });

    // 아바타를 클릭하면 ST가 확대창을 만드는데, 경로를 '/characters/' + src로
    // 조립하는 탓에 우리가 바꾼 이미지는 없는 주소가 된다. 만들어진 창을 바로잡는다.
    // (우리 핸들러가 ST 것보다 늦게 등록되므로 창은 이미 존재한다)
    document.addEventListener('click', (e) => {
        const img = e.target.closest?.('#chat .mes .avatar')?.querySelector('img');
        const src = img?.getAttribute('src');
        if (!src || !img.dataset.maKey || sameUrl(src, img.dataset.maOrig)) return; // 원본이면 ST 기본 동작에 맡긴다

        // ST도 우리가 이미 바꿔놓은 현재 src로부터 forChar를 만들기 때문에(같은 방식으로
        // 깨진 값이라도) 여기서 같은 로직을 그대로 따라야 방금 만든 확대창을 찾아낸다.
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
});
