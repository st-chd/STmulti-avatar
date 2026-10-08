/**
 * 캐릭터·페르소나 추가 아바타 관리.
 * 목록은 기본 이미지, 채팅은 방별 선택을 우선한다.
 */

import { user_avatar } from '../../../personas.js';
import { isGenerating, saveSettings } from '../../../../script.js';

const KEY = 'multiAvatar';
const IMG_ROOT = 'user/images';
const PERSONA_PREFIX = 'persona:';
const isPersona = key => key.startsWith(PERSONA_PREFIX);
const avatarFile = key => isPersona(key) ? key.slice(PERSONA_PREFIX.length) : key;
const personaKey = file => `${PERSONA_PREFIX}${file}`;

const ctx = () => SillyTavern.getContext();

const charIndex = (key) => ctx().characters.findIndex(c => c?.avatar === key);
let mutationTail = Promise.resolve();
const mutate = action => {
    const result = mutationTail.then(action);
    mutationTail = result.catch(() => {});
    return result;
};
const handleAction = action => action().catch(error => {
    console.error('[Multi Avatar]', error);
    toastr.error(error.message || '이미지 설정을 저장하지 못했습니다.', 'Multi Avatar');
    refresh(); renderStrip();
});
const libraries = new Map();
const libraryLoads = new Map();
const libraryFailures = new Map();

function cacheLibrary(key, data, source) {
    data = sanitizeCard(data);
    libraries.set(key, { data, source });
    const settings = ctx().extensionSettings[KEY] ??= {};
    if (data) {
        if (JSON.stringify(settings.index?.[key]) === JSON.stringify(data)) return;
        settings.index = { ...settings.index, [key]: data };
    } else if (settings.index && Object.hasOwn(settings.index, key)) {
        delete settings.index[key];
    }
    if (settings.index && !Object.keys(settings.index).length) delete settings.index;
    if (!Object.keys(settings).length) delete ctx().extensionSettings[KEY];
    ctx().saveSettingsDebounced();
}

function pruneLibraries() {
    const alive = new Set(ctx().characters.map(ch => ch.avatar));
    for (const key of libraries.keys()) if (!alive.has(key)) libraries.delete(key);
    for (const key of libraryFailures.keys()) if (!alive.has(key)) libraryFailures.delete(key);
    const index = ctx().extensionSettings[KEY]?.index;
    if (index) {
        let changed = false;
        for (const key of Object.keys(index)) if (!alive.has(key)) { delete index[key]; changed = true; }
        if (changed) ctx().saveSettingsDebounced();
    }
    const renamed = ctx().extensionSettings[KEY]?.renamed;
    if (renamed) {
        let changed = false;
        for (const [oldAvatar, newAvatar] of Object.entries(renamed)) {
            if (!alive.has(newAvatar)) { delete renamed[oldAvatar]; changed = true; }
        }
        if (!Object.keys(renamed).length) delete ctx().extensionSettings[KEY].renamed;
        if (changed) ctx().saveSettingsDebounced();
    }
    const settings = ctx().extensionSettings[KEY];
    if (settings?.index && !Object.keys(settings.index).length) {
        delete settings.index;
        ctx().saveSettingsDebounced();
    }
    if (settings && !Object.keys(settings).length) {
        delete ctx().extensionSettings[KEY];
        ctx().saveSettingsDebounced();
    }
}

async function loadLibrary(key, force = false) {
    if (isPersona(key)) return cardData(key);
    const character = ctx().characters.find(ch => ch?.avatar === key);
    if (!character) return null;
    if (!character.shallow) return cardData(key);
    if (!force && libraries.get(key)?.source === character) return libraries.get(key).data;
    if (libraryLoads.has(key)) return libraryLoads.get(key);
    const loading = cleanupRequest('/api/characters/get', { avatar_url: key }).then(full => {
        if (!full || full.shallow || full.avatar !== key) throw new Error('캐릭터 데이터를 불러오지 못했습니다.');
        const data = sanitizeCard(full.data?.extensions?.[KEY]);
        if (ctx().characters.includes(character) && !deletedCharacters.has(character)) cacheLibrary(key, data, character);
        return data;
    }).catch(error => { libraryFailures.set(key, Date.now() + 30_000); throw error; })
        .finally(() => libraryLoads.delete(key));
    libraryLoads.set(key, loading);
    return loading;
}

async function saveLocalSettings() {
    const expected = JSON.stringify(ctx().extensionSettings[KEY] ?? null);
    await saveSettings();
    const result = await cleanupRequest('/api/settings/get', {});
    const saved = JSON.parse(result?.settings ?? 'null');
    if (JSON.stringify(saved?.extension_settings?.[KEY] ?? null) !== expected) {
        throw new Error('추가 이미지 설정을 서버에 저장하지 못했습니다. 이미지 파일은 보존했습니다.');
    }
}

const escapeHtml = value => String(value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const validPathPart = value => {
    try { assertPathPart(value); return true; } catch { return false; }
};

function sanitizeCard(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const files = [...new Set(Array.isArray(data.files) ? data.files.filter(validPathPart) : [])];
    return { files, list: files.includes(data.list) ? data.list : null,
        ...(validPathPart(data.dir) ? { dir: data.dir } : {}) };
}

function ownedImages() {
    const owned = ctx().extensionSettings[KEY]?.owned;
    return Array.isArray(owned) ? owned.filter(record => validPathPart(record?.dir) && Array.isArray(record.files))
        .map(record => ({ dir: record.dir, files: record.files.filter(validPathPart),
            ...(record.kind === 'persona' || record.kind === 'character' ? { kind: record.kind } : {}) })) : [];
}

function isOwnedImage(dir, file) {
    const owned = ctx().extensionSettings[KEY]?.owned;
    return Array.isArray(owned) && owned.some(record => record?.dir === dir && Array.isArray(record.files) && record.files.includes(file));
}

function rememberOwned(dir, files, key) {
    const kind = key ? (isPersona(key) ? 'persona' : 'character') : undefined;
    const settings = ctx().extensionSettings[KEY] ??= {};
    const existing = ownedImages().find(item => item.dir === dir && item.kind === kind);
    if (existing && files.every(file => existing.files.includes(file))) return;
    const owned = settings.owned = ownedImages().map(record => ({ ...record, files: [...record.files] }));
    const record = owned.find(item => item.dir === dir && item.kind === kind);
    if (record) record.files = [...new Set([...record.files, ...files])];
    else owned.push({ dir, files: [...new Set(files)], ...(kind ? { kind } : {}) });
}

// 구버전은 현재 카드에서 파생된 폴더와 생성 파일명이 함께 일치할 때만 소유권을 이관한다.
function adoptLegacyImages(key, data) {
    if (!data?.files.length) return;
    const dir = imageDir(key, data);
    const known = data.files.filter(file => isOwnedImage(dir, file));
    if (known.length) rememberOwned(dir, known, key);
    const base = avatarFile(key).replace(/\.[^.]+$/, '');
    const expected = [avatarFile(key), `${isPersona(key) ? 'persona_' : ''}${base}_avatar`];
    if (!expected.includes(dir)) return;
    const prefixes = [dir.replace(/\./g, '_'), base];
    const files = data.files.filter(file => prefixes.some(prefix => {
        if (!file.startsWith(`${prefix}_add`)) return false;
        return /^\d+(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.png$/i.test(file.slice(prefix.length + 4));
    }) && !isOwnedImage(dir, file));
    if (files.length) { rememberOwned(dir, files, key); ctx().saveSettingsDebounced(); }
}

function cardData(key) {
    if (isPersona(key)) return sanitizeCard(ctx().extensionSettings[KEY]?.personas?.[avatarFile(key)]);
    const c = ctx().characters.find(x => x?.avatar === key);
    if (c?.shallow) {
        if (libraries.get(key)?.source === c) return libraries.get(key).data;
        const index = ctx().extensionSettings[KEY]?.index;
        return sanitizeCard(index && Object.hasOwn(index, key) ? index[key] : null);
    }
    return sanitizeCard(c?.data?.extensions?.[KEY]);
}

async function writeCard(key, data) {
    if (data !== undefined) data = sanitizeCard(data);
    if (isPersona(key)) {
        const c = ctx();
        const previous = structuredClone(c.extensionSettings[KEY] ?? null);
        const settings = c.extensionSettings[KEY] ??= {};
        const personas = settings.personas ??= {};
        if (data === undefined) delete personas[avatarFile(key)];
        else personas[avatarFile(key)] = data;
        if (!Object.keys(personas).length) delete settings.personas;
        if (!Object.keys(settings).length) delete c.extensionSettings[KEY];
        try { await saveLocalSettings(); } catch (error) {
            if (previous === null) delete c.extensionSettings[KEY];
            else c.extensionSettings[KEY] = previous;
            throw error;
        }
        return;
    }
    if (charIndex(key) < 0) throw new Error('캐릭터가 삭제되었거나 변경되었습니다.');
    const result = await ctx().writeExtensionFieldBulk([key], KEY, data === undefined ? ctx().constants.unset : data);
    if (!result || result.failed?.length || !(data === undefined
        ? [...(result.updated ?? []), ...(result.skipped ?? [])] : result.updated ?? []).includes(key)) {
        throw new Error('캐릭터 이미지 설정을 저장하지 못했습니다. 이미지 파일은 보존했습니다.');
    }
    cacheLibrary(key, data, ctx().characters[charIndex(key)]);
}

let importGuardCleanup = null;
let originalFetchForCleanup = null;
const deletedLibraries = new WeakMap();
let chatWriteTail = Promise.resolve();

function withChatLock(action) {
    const result = chatWriteTail.then(() => globalThis.navigator?.locks
        ? navigator.locks.request('multi-avatar-chat-writes', action) : action());
    chatWriteTail = result.catch(() => {});
    return result;
}

function currentChatTarget() {
    const c = ctx();
    const id = c.chatId ?? c.getCurrentChatId?.();
    if (!id) return null;
    return c.groupId ? { group: true, id } : { group: false, avatar: c.characters[c.characterId]?.avatar, id };
}

const sameChat = (a, b) => !!a && !!b && a.group === b.group && a.id === b.id && a.avatar === b.avatar;
const chatGet = target => target.group ? '/api/chats/group/get' : '/api/chats/get';
const chatBody = target => target.group ? { id: target.id } : { avatar_url: target.avatar, file_name: target.id };

async function saveCurrentMetadata(target) {
    if (!target) return;
    if (!sameChat(target, currentChatTarget())) throw new Error('채팅이 변경되었습니다. 다시 시도해 주세요.');
    const expected = JSON.stringify(ctx().chatMetadata?.[KEY] ?? null);
    await ctx().saveMetadata();
    const chat = await cleanupRequest(chatGet(target), chatBody(target));
    if (JSON.stringify(chat?.[0]?.chat_metadata?.[KEY] ?? null) !== expected) {
        throw new Error('채팅 이미지 선택을 저장하지 못했습니다.');
    }
}

function installImportGuard() {
    if (importGuardCleanup) return;
    const originalFetch = window.fetch;
    originalFetchForCleanup = originalFetch;
    let active = true;
    // 현재 실리태번에는 카드 불러오기 이벤트가 없어 목록 갱신 전에 새 카드의 설정만 분리한다.
    const guardedFetch = async function (input, options) {
        let url;
        try { url = new URL(input instanceof Request ? input.url : input, location.origin); }
        catch { return originalFetch.call(this, input, options); }
        if (active && url.origin === location.origin && ['/api/chats/save', '/api/chats/group/save'].includes(url.pathname)) {
            return withChatLock(() => originalFetch.call(this, input, options));
        }
        if (active && url.origin === location.origin && ['/api/characters/delete', '/api/characters/rename'].includes(url.pathname)
            && typeof options?.body === 'string') {
            const avatar = JSON.parse(options.body).avatar_url;
            await mutationTail;
            const character = ctx().characters.find(ch => ch?.avatar === avatar);
            if (character) {
                try { deletedLibraries.set(character, await loadLibrary(avatar, true)); }
                catch (error) { toastr.warning('추가 이미지 정보를 읽지 못해 이미지 파일은 보존합니다.', 'Multi Avatar'); }
            }
        }
        const isImport = active && options?.body instanceof FormData
            && url.origin === location.origin && url.pathname === '/api/characters/import';
        const preservedName = isImport && options.body.get('preserved_name');
        // Assets의 신규 설치에도 preserved_name이 전달되므로 요청 전에 기존 카드 여부를 확인한다.
        const replacing = typeof preservedName === 'string' && preservedName
            && charIndex(`${preservedName.replace(/\.[^.]*$/, '')}.png`) >= 0;
        const previous = replacing ? await loadLibrary(`${preservedName.replace(/\.[^.]*$/, '')}.png`) : null;
        const response = await originalFetch.call(this, input, options);
        if (!active || !isImport || !response.ok) return response;
        const imported = await response.clone().json().catch(() => null);
        if (!imported) return response;
        if (imported.error || !imported.file_name) return response;

        const avatar = `${imported.file_name}.png`;
        let separationError;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (!active) return response;
            try {
                const c = ctx();
                const result = await c.writeExtensionFieldBulk([avatar], KEY, replacing && previous ? previous : c.constants.unset);
                if (!result || result.failed?.length
                    || ![...(result.updated ?? []), ...(result.skipped ?? [])].includes(avatar)) {
                    throw new Error('불러온 캐릭터의 추가 이미지 설정을 분리하지 못했습니다.');
                }
                libraries.delete(avatar);
                if (c.extensionSettings[KEY]?.index) delete c.extensionSettings[KEY].index[avatar];
                return response;
            } catch (error) {
                separationError = error;
            }
        }
        // 카드는 이미 생성되었으므로 성공 응답을 유지해 본체의 손상 오류와 중복 불러오기를 막는다.
        console.error('[Multi Avatar] 카드 생성 후 설정 분리 실패', avatar, separationError);
        try {
            await ctx().getCharacters();
        } catch (error) {
            console.error('[Multi Avatar] 생성된 캐릭터 목록 동기화 실패', error);
        }
        toastr.warning('캐릭터 생성은 성공했지만 추가 이미지 설정 분리에 실패했습니다. 다시 불러오지 말고 해당 카드의 추가 이미지 설정을 확인해 주세요.', 'Multi Avatar', { timeOut: 10000 });
        return response;
    };
    window.fetch = guardedFetch;
    importGuardCleanup = () => {
        active = false;
        if (window.fetch === guardedFetch) window.fetch = originalFetch;
        originalFetchForCleanup = null;
        importGuardCleanup = null;
    };
}

/** 채팅별 선택값. undefined는 미설정, 빈 문자열은 원본 고정. */
const chatKeys = key => [key, ...Object.entries(ctx().extensionSettings[KEY]?.renamed ?? {})
    .filter(([, newAvatar]) => newAvatar === key).map(([oldAvatar]) => oldAvatar)];
const chatOverride = key => {
    const map = ctx().chatMetadata?.[KEY];
    const storedKey = chatKeys(key).find(candidate => map && Object.hasOwn(map, candidate));
    return storedKey === undefined ? undefined : map[storedKey];
};

async function setChatOverride(key, value) {
    const target = currentChatTarget();
    return mutate(async () => {
        if (target && !sameChat(target, currentChatTarget())) throw new Error('채팅이 변경되었습니다. 다시 선택해 주세요.');
        const c = ctx();
        const previous = { ...(c.chatMetadata?.[KEY] ?? {}) };
        const map = { ...(c.chatMetadata?.[KEY] ?? {}) };
        for (const previousKey of chatKeys(key)) delete map[previousKey];
        if (value === undefined) delete map[key];
        else map[key] = value;
        replaceChatMap(map);
        try { await saveCurrentMetadata(target); } catch (error) {
            if (!target || sameChat(target, currentChatTarget())) replaceChatMap(previous);
            throw error;
        }
        refresh();
    });
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
    return imageDir(key, d);
}

function imageDir(key, d) {
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
const originalImageErrors = new WeakMap();
function probe(url) {
    const cached = probed.get(url);
    if (cached && cached.expires > Date.now()) return cached.promise;

    const entry = { expires: Date.now() + 300_000 };
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
    const cssUrl = url => `url(${JSON.stringify(url)})`;
    mes.style.setProperty('--mes-avatar-thumb-url', cssUrl(t));
    mes.style.setProperty('--mes-avatar-original-url', cssUrl(o));
    mes.style.setProperty('--mes-avatar-url', cssUrl(t));
}

let refreshFrame = null;
function scheduleRefresh() {
    if (refreshFrame !== null) return;
    refreshFrame = requestAnimationFrame(() => { refreshFrame = null; refresh(); renderStrip(); });
}

function hydrateVisible(key) {
    const character = ctx().characters.find(ch => ch?.avatar === key);
    if (!character?.shallow || libraries.get(key)?.source === character || libraryLoads.has(key)
        || libraryFailures.get(key) > Date.now()) return;
    loadLibrary(key).then(scheduleRefresh).catch(error => console.error('[Multi Avatar] 이미지 정보 로드 실패', error));
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

        if (!isPersona(key)) hydrateVisible(key);

        const file = resolve(key, mode);
        const wantUrl = file ? imgUrl(key, file) : img.dataset.maOrig;
        if (sameUrl(img.getAttribute('src'), wantUrl)) continue;

        if (!file) {
            if (originalImageErrors.has(img)) {
                img.onerror = originalImageErrors.get(img);
                originalImageErrors.delete(img);
            }
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
                if (!originalImageErrors.has(img)) originalImageErrors.set(img, img.onerror);
                img.onerror = () => {
                    img.onerror = originalImageErrors.get(img);
                    originalImageErrors.delete(img);
                    if (!sameUrl(img.getAttribute('src'), wantUrl)) return;
                    probed.set(wantUrl, { promise: Promise.resolve(false), expires: Date.now() + 30_000 });
                    img.src = img.dataset.maOrig;
                    delete img.dataset.maApplied;
                    syncThemeVars(img, img.dataset.maOrig, originalUrl(key));
                };
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
        if (originalImageErrors.has(img)) {
            img.onerror = originalImageErrors.get(img);
            originalImageErrors.delete(img);
        }
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
            await handleAction(() => setChatOverride(key, isDefault ? undefined : (f ?? '')));
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

/** 터치 기기에서만 길게 누르는 삭제 동작을 사용한다. */
const COMPACT_QUERY = '(hover: none) and (pointer: coarse)';
const isCompact = () => matchMedia(COMPACT_QUERY).matches;

/** 길게 눌렀을 때 뒤따르는 클릭을 막고 콜백을 실행한다. */
function bindLongPress(el, onLongPress, { enabled = () => true, threshold = 500 } = {}) {
    let timer = null;
    let fired = false;
    let origin;
    const start = event => {
        if (event.button !== 0) return;
        if (!enabled()) return;
        clearTimeout(timer);
        fired = false;
        origin = [event.clientX, event.clientY];
        el.classList.add('ma-pressing');
        timer = setTimeout(() => {
            if (!el.isConnected) return cancel();
            fired = true; el.classList.remove('ma-pressing'); onLongPress();
        }, threshold);
    };
    const cancel = () => { clearTimeout(timer); timer = null; el.classList.remove('ma-pressing'); };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointermove', event => {
        if (timer && origin && Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 10) cancel();
    });
    el.addEventListener('contextmenu', event => { if (enabled()) event.preventDefault(); });
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
    orig.querySelector('img').onclick = () => handleAction(() => setListImage(key, null));
    markMissing(orig.querySelector('img'));
    strip.append(orig);

    for (const f of files) {
        const tile = document.createElement('div');
        tile.className = 'ma-tile' + (f === list ? ' selected' : '');
        tile.title = f === list
            ? `${f}\n기본 이미지로 쓰는 중.`
            : `${f}\n클릭하면 기본 이미지로 지정합니다.`;
        if (isCompact()) tile.title += '\n길게 누르면 삭제합니다.';

        // 터치 화면에서는 × 대신 길게 눌러 삭제한다.
        tile.innerHTML = `<img src="${imgUrl(key, f)}">`
            + '<div class="ma-check fa-solid fa-check"></div>'
            + '<div class="ma-del fa-solid fa-xmark" title="삭제"></div>';

        markMissing(tile.querySelector('img'));
        tile.querySelector('img').onclick = () => handleAction(() => setListImage(key, f));
        tile.querySelector('.ma-del').onclick = (e) => { e.stopPropagation(); handleAction(() => deleteImage(key, f)); };
        bindLongPress(tile, () => handleAction(() => deleteImage(key, f)), { enabled: isCompact });
        strip.append(tile);
    }

    const plus = document.createElement('div');
    plus.className = 'ma-tile ma-add fa-solid fa-plus';
    plus.title = '이미지 추가';
    plus.onclick = () => addImage(key);
    strip.append(plus);
}

async function setListImage(key, file) {
    return mutate(async () => {
        await loadLibrary(key);
        const existing = cardData(key);
        if (file !== null && !existing?.files.includes(file)) throw new Error('선택한 이미지가 삭제되었습니다.');
        if ((!existing && file === null) || existing?.list === file) return;
        const d = existing ?? { files: [] };
        await writeCard(key, { ...d, list: file });
        renderStrip();
        refresh();
    });
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
    if (w * h > 32_000_000) throw new Error('이미지가 너무 큽니다. 3,200만 화소 이하의 이미지를 사용해 주세요.');
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
        toastr.error(error.message || '이미지 업로드에 실패했습니다.');
    } finally {
        uploading = false;
    }
}

let uploading = false;

async function uploadImage(key) {
    return mutate(async () => {
        const file = await pickFile();
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) throw new Error('20MB 이하의 이미지 파일을 사용해 주세요.');

        const { Popup, POPUP_TYPE } = ctx();
        const dataUrl = await readAsDataUrl(file);

        let crop;
        if (!ctx().powerUserSettings.never_resize_avatars) {
            const dlg = new Popup('이미지 자르기', POPUP_TYPE.CROP, '', { cropImage: dataUrl });
            if (!await dlg.show()) return;
            crop = dlg.cropData;
        }

        await loadLibrary(key);
        if (!isPersona(key) && charIndex(key) < 0) throw new Error('캐릭터가 삭제되었습니다.');
        const d = cardData(key) ?? { files: [], list: null };
        const dir = d.files.length ? dirOf(key) : `multi-avatar_${isPersona(key) ? 'persona_' : ''}${avatarFile(key).replace(/\.[^.]+$/, '')}`;
        assertPathPart(dir);
        const base = dir.replace(/\./g, '_');

        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({
                image: await cropToPng(dataUrl, crop),
                format: 'png',
                // 삭제 후 같은 경로를 재사용하면 브라우저가 이전 크롭 이미지를 보여줄 수 있다.
                filename: `${base}_add1_${ctx().uuidv4()}`,
                ch_name: dir,
            }),
        });
        if (!res.ok) throw new Error('이미지 업로드에 실패했습니다.');

        const uploadedPath = (await res.json()).path;
        const path = typeof uploadedPath === 'string' ? uploadedPath.replace(/^\/(?=user\/images\/)/, '').split('/') : null;
        if (path?.length !== 4 || path[0] !== 'user' || path[1] !== 'images'
            || !validPathPart(path[2]) || !validPathPart(path[3])) throw new Error('업로드 경로가 올바르지 않습니다.');
        const saved = path[3];
        rememberOwned(path[2], [saved], key);
        await saveLocalSettings();
        const latest = cardData(key) ?? { files: [], list: null };
        if (latest.files.length && imageDir(key, latest) !== path[2]) throw new Error('이미지 폴더가 변경되었습니다. 다시 시도해 주세요.');
        await writeCard(key, { ...latest, dir: path[2], files: [...latest.files, saved] });
        renderStrip();
        refresh();
    });
}

async function deleteImage(key, file) {
    if (!await ctx().Popup.show.confirm('이미지 삭제', `${escapeHtml(file)} 을(를) 삭제할까요?`)) return;

    return mutate(async () => {
        await loadLibrary(key);
        const d = cardData(key);
        if (!d?.files.includes(file)) return;
        const dir = imageDir(key, d);
        adoptLegacyImages(key, d);

        const files = (d.files ?? []).filter(f => f !== file);
        await writeCard(key, files.length ? {
            ...d,
            files,
            list: d.list === file ? null : d.list,
        } : undefined);

        if (chatOverride(key) === file) {
            const map = { ...ctx().chatMetadata[KEY] };
            for (const previousKey of chatKeys(key)) delete map[previousKey];
            replaceChatMap(map);
            await saveCurrentMetadata(currentChatTarget());
        }
        await saveLocalSettings();
        await deleteUnreferencedImages(dir, [file], new Set([key]));
        probed.clear();

        renderStrip();
        refresh();
    });
}

/** 폴더의 지정한 파일만 삭제한다. */
async function deleteFolder(dir, files) {
    assertPathPart(dir);
    for (const file of files ?? []) assertPathPart(file);
    const allowed = new Set(ownedImages().filter(record => record.dir === dir).flatMap(record => record.files));
    const deleted = new Set();
    let preserved = 0;
    try {
        for (const f of files ?? []) {
            if (!allowed.has(f)) { preserved++; continue; }
            const response = await fetch('/api/images/delete', {
                method: 'POST',
                headers: ctx().getRequestHeaders(),
                body: JSON.stringify({ path: `${IMG_ROOT}/${dir}/${f}` }),
            });
            if (!response.ok && response.status !== 404) throw new Error(`이미지 삭제 실패: ${f}`);
            deleted.add(f);
        }
    } finally {
        const settings = ctx().extensionSettings[KEY];
        if (deleted.size && settings?.owned) {
            settings.owned = ownedImages().map(record => record.dir === dir
                ? { ...record, files: record.files.filter(file => !deleted.has(file)) } : record).filter(record => record.files.length);
            if (!settings.owned.length) delete settings.owned;
            if (!Object.keys(settings).length) delete ctx().extensionSettings[KEY];
            ctx().saveSettingsDebounced();
        }
        if (preserved) toastr.warning(`생성 기록을 확인할 수 없는 이미지 ${preserved}개는 보존했습니다.`, 'Multi Avatar');
    }
    return preserved;
}

function assertPathPart(value) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..'
        || /[\\/\u0000-\u001f<>:"|?*]/.test(value) || /[. ]$/.test(value)) {
        throw new Error('추가 이미지 경로가 올바르지 않습니다.');
    }
}

const deletedCharacters = new WeakSet();

/** PNG 재불러오기로 공유된 파일은 다른 카드나 페르소나가 사용하는 동안 보존한다. */
async function referenceIndex(excludedKeys) {
    const pending = ctx().characters.filter(ch => ch?.shallow && !deletedCharacters.has(ch) && !excludedKeys.has(ch.avatar));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (next < pending.length) await loadLibrary(pending[next++].avatar);
    }));
    const referenced = new Map();
    const collect = (key, data) => {
        if (excludedKeys.has(key) || !data?.files?.length) return;
        const dir = imageDir(key, data);
        if (!referenced.has(dir)) referenced.set(dir, new Set());
        for (const file of data.files) referenced.get(dir).add(file);
    };
    for (const ch of ctx().characters) {
        if (ch?.avatar && !deletedCharacters.has(ch)) collect(ch.avatar, cardData(ch.avatar));
    }
    for (const [file, data] of Object.entries(ctx().extensionSettings[KEY]?.personas ?? {})) collect(personaKey(file), sanitizeCard(data));
    return referenced;
}

async function deleteUnreferencedImages(dir, files, excludedKeys, references) {
    if (!files?.length) return;
    references ??= await referenceIndex(excludedKeys);
    return deleteFolder(dir, files.filter(file => !references.get(dir)?.has(file)));
}

/** 캐릭터 카드에 등록된 추가 이미지를 삭제한다. */
function deleteCardImages(char, excludedKeys = new Set([char.avatar])) {
    const d = deletedLibraries.get(char) ?? cardData(char.avatar) ?? sanitizeCard(char?.data?.extensions?.[KEY]);
    if (!d?.files?.length) return Promise.resolve();
    adoptLegacyImages(char.avatar, d);
    return deleteUnreferencedImages(imageDir(char.avatar, d), d.files, excludedKeys);
}

async function deletePersonaImages(file, excludedKeys = new Set([personaKey(file)])) {
    const key = personaKey(file);
    const data = cardData(key);
    const dir = imageDir(key, data);
    adoptLegacyImages(key, data);
    await writeCard(key, undefined);
    if (data?.files?.length) await deleteUnreferencedImages(dir, data.files, excludedKeys);
}

async function purgeCards() {
    const c = ctx();
    if (typeof c.constants?.unset !== 'string') throw new Error('카드 데이터 삭제 API를 사용할 수 없습니다.');
    const expected = c.characters.filter(ch => cardData(ch.avatar) !== null).map(ch => ch.avatar);
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
async function cleanupRequest(url, body, fetcher = fetch) {
    const response = await fetcher(url, {
        method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`정리 요청 실패: ${url} (${response.status})`);
    return response.json().catch(() => null);
}

/** 선택한 종류의 이미지, 설정, 채팅 선택 정보를 정리한다. */
async function purgeAll(log, scope = 'all') {
    return mutate(async () => {
        const c = ctx();
        if (isGenerating()) throw new Error('응답 생성이 끝난 뒤 정리해 주세요.');
        if (scope !== 'persona' && typeof c.constants?.unset !== 'string') {
            throw new Error('카드 데이터 삭제 API를 사용할 수 없습니다.');
        }
        const dialog = document.createElement?.('dialog');
        if (dialog) {
            dialog.className = 'ma-progress';
            dialog.setAttribute('aria-label', '추가 이미지 정리');
            dialog.setAttribute('aria-live', 'polite');
            dialog.addEventListener('cancel', event => event.preventDefault());
            document.body.append(dialog);
            dialog.showModal();
        }
        const report = message => { log(message); if (dialog) dialog.textContent = message; };
        try {
            if (scope !== 'persona') await referenceIndex(new Set());
            const chars = ctx().characters ?? [];
            const excludedKeys = new Set([
                ...(scope !== 'persona' ? chars.map(ch => ch.avatar) : []),
                ...(scope !== 'character' ? Object.keys(c.extensionSettings[KEY]?.personas ?? {}).map(personaKey) : []),
            ]);

            const plans = new Map();
            const plan = (key, data) => {
                if (!data?.files.length) return;
                adoptLegacyImages(key, data);
                const dir = imageDir(key, data);
                plans.set(dir, new Set([...(plans.get(dir) ?? []), ...data.files]));
            };
            if (scope !== 'persona') for (const ch of chars) plan(ch.avatar, cardData(ch.avatar));
            if (scope !== 'character') for (const [file, data] of Object.entries(c.extensionSettings[KEY]?.personas ?? {})) plan(personaKey(file), sanitizeCard(data));
            for (const record of ownedImages()) {
                if (scope !== 'all' && record.kind !== scope) continue;
                plans.set(record.dir, new Set([...(plans.get(record.dir) ?? []), ...record.files]));
            }
            const references = await referenceIndex(excludedKeys);
            report('이미지 설정 저장 중...');
            if (scope !== 'persona') {
                await purgeCards();
                for (const ch of chars) libraries.delete(ch.avatar);
            }
            const settings = c.extensionSettings[KEY];
            const previousPersonas = structuredClone(settings?.personas ?? null);
            if (settings) {
                if (scope !== 'character') delete settings.personas;
                if (scope !== 'persona') delete settings.renamed;
                if (settings.index) {
                    for (const key of Object.keys(settings.index)) if (excludedKeys.has(key)) delete settings.index[key];
                    if (!Object.keys(settings.index).length) delete settings.index;
                }
                if (!Object.keys(settings).length) delete c.extensionSettings[KEY];
            }
            try { await saveLocalSettings(); } catch (error) {
                if (scope !== 'character' && previousPersonas) {
                    (c.extensionSettings[KEY] ??= {}).personas = previousPersonas;
                }
                throw error;
            }

            let done = 0;
            for (const ch of chars) {
                report(`채팅 정리 중... (${++done}/${chars.length})`);
                const list = await cleanupRequest('/api/characters/chats', { avatar_url: ch.avatar, simple: true });
                if (!Array.isArray(list)) continue;

                for (const { file_id } of list) {
                    await cleanStoredChat({ group: false, avatar: ch.avatar, id: file_id }, scope);
                }
            }

            report('그룹 채팅 정리 중...');
            const groups = await cleanupRequest('/api/groups/all', {}) ?? [];
            for (const g of groups) {
                for (const id of g?.chats ?? []) {
                    await cleanStoredChat({ group: true, id }, scope);
                }
            }

            const current = { chat_metadata: { [KEY]: { ...(ctx().chatMetadata?.[KEY] ?? {}) } } };
            if (stripMeta([current], scope)) {
                replaceChatMap(current.chat_metadata[KEY] ?? {});
                await saveCurrentMetadata(currentChatTarget());
            }
            report('이미지 파일 삭제 중...');
            let preserved = 0;
            for (const [dir, files] of plans) preserved += await deleteUnreferencedImages(dir, [...files], excludedKeys, references) ?? 0;
            await saveLocalSettings();
            probed.clear();
            closePicker();

            const completed = scope === 'all' ? '모든 데이터 정리가 완료되었습니다.'
                : `${scope === 'persona' ? '페르소나' : '캐릭터'} 추가 이미지와 관련 설정 정리가 완료되었습니다.`;
            report(completed + (preserved ? ` 생성 기록을 확인할 수 없는 파일 ${preserved}개는 보존했습니다.` : ''));
        } finally { dialog?.close(); dialog?.remove(); }
    });
}

async function cleanStoredChat(target, scope) {
    return withChatLock(async () => {
        // 열린 채팅은 디스크 사본 대신 현재 메시지를 사용하는 본체 저장 경로로 처리한다.
        if (sameChat(target, currentChatTarget())) return;
        const fetcher = originalFetchForCleanup ?? fetch;
        const body = chatBody(target);
        const chat = await cleanupRequest(chatGet(target), body, fetcher);
        const snapshot = JSON.stringify(chat);
        if (!stripMeta(chat, scope)) return;
        const latest = await cleanupRequest(chatGet(target), body, fetcher);
        if (sameChat(target, currentChatTarget()) || JSON.stringify(latest) !== snapshot) {
            throw new Error('정리 중 채팅 내용이 변경되었습니다. 이미지 파일은 보존했습니다. 다시 시도해 주세요.');
        }
        const url = target.group ? '/api/chats/group/save' : '/api/chats/save';
        await cleanupRequest(url, { ...body, chat }, fetcher);
    });
}

/** 확장 삭제 시에도 채팅 선택 정보를 포함해 동일하게 정리한다. */
export async function cleanUp() {
    await purgeAll(() => {});
    importGuardCleanup?.();
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
                <small><strong>추가 이미지를 제거</strong>합니다. 되돌릴 수 없습니다.</small>
                <div class="flex-container">
                    <button type="button" class="menu_button menu_button_icon" id="ma_purge">
                        <i class="fa-solid fa-broom"></i><span>모든 데이터</span>
                    </button>
                    <button type="button" class="menu_button menu_button_icon" id="ma_purge_persona">
                        <i class="fa-solid fa-user"></i><span>페르소나</span>
                    </button>
                    <button type="button" class="menu_button menu_button_icon" id="ma_purge_character">
                        <i class="fa-solid fa-address-card"></i><span>캐릭터</span>
                    </button>
                </div>
                <div id="ma_purge_status" class="ma-status"></div>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);

    const actions = [
        ['ma_purge', 'all', '모든 데이터 정리', '전체'],
        ['ma_purge_persona', 'persona', '페르소나 이미지 정리', '모든 페르소나의'],
        ['ma_purge_character', 'character', '캐릭터 이미지 정리', '모든 캐릭터의'],
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
                <small>추가 이미지는 정지 PNG로 저장됩니다. GIF·WebP의 애니메이션은 유지되지 않습니다.</small>
            </div>
        </div>`);
}

jQuery(async () => {
    const { eventSource, event_types } = ctx();

    if (typeof ctx().writeExtensionFieldBulk !== 'function' || typeof ctx().updateChatMetadata !== 'function'
        || typeof ctx().constants?.unset !== 'string') {
        toastr.error('Multi Avatar에 필요한 API가 없습니다. SillyTavern을 업데이트해 주세요.');
        return;
    }

    installImportGuard();
    if (ctx().characters.length) pruneLibraries();
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

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
        pruneLibraries();
        swap(document.getElementById('rm_print_characters_block'), 'list');
    });
    for (const e of [event_types.CHAT_CHANGED, event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_UPDATED]) {
        eventSource.on(e, () => {
            if (e === event_types.CHAT_CHANGED) closePicker();
            const chat = document.getElementById('chat');
            swap(chat, 'chat');
            syncMesButtons(chat);
        });
    }
    eventSource.on(event_types.CHARACTER_EDITED, () => {
        const key = panelKey();
        if (key) libraries.delete(key);
        refresh(); renderStrip();
    });
    for (const event of [event_types.PERSONA_CHANGED, event_types.PERSONA_CREATED,
        event_types.PERSONA_UPDATED, event_types.PERSONA_RENAMED]) {
        if (event) eventSource.on(event, () => { closePicker(); refresh(); renderStrip(); });
    }
    if (event_types.PERSONA_DELETED) eventSource.on(event_types.PERSONA_DELETED, async ({ avatarId }) => {
        await handleAction(() => mutate(() => deletePersonaImages(avatarId)));
        if (chatOverride(personaKey(avatarId)) !== undefined) await handleAction(() => setChatOverride(personaKey(avatarId), undefined));
        probed.clear();
        closePicker();
        refresh();
        renderStrip();
    });

    eventSource.on(event_types.CHARACTER_DELETED, async ({ character }) => {
        // 본체는 일괄 삭제가 끝날 때 배열을 갱신하므로 이미 삭제된 객체는 참조 검사에서 제외한다.
        deletedCharacters.add(character);
        await handleAction(() => mutate(async () => {
            await deleteCardImages(character);
            libraries.delete(character.avatar);
            const index = ctx().extensionSettings[KEY]?.index;
            if (index) delete index[character.avatar];
            ctx().saveSettingsDebounced();
        }));
    });

    eventSource.on(event_types.CHARACTER_DUPLICATED, async ({ newAvatar }) => {
        await handleAction(() => mutate(async () => {
            await ctx().getCharacters();
            await writeCard(newAvatar, undefined);
        }));
    });

    // 구버전 데이터는 이름 변경 전 키를 폴더명으로 보존한다.
    eventSource.on(event_types.CHARACTER_RENAMED, async (oldAvatar, newAvatar) => {
        await handleAction(() => mutate(async () => {
            resetMarks();
            const d = await loadLibrary(oldAvatar);
            if (d?.files?.length) {
                adoptLegacyImages(oldAvatar, d);
                const data = { ...d, dir: imageDir(oldAvatar, d) };
                const result = await ctx().writeExtensionFieldBulk([newAvatar], KEY, data);
                if (!result?.updated?.includes(newAvatar)) throw new Error('이름 변경 후 이미지 설정을 저장하지 못했습니다.');
                cacheLibrary(newAvatar, data, undefined);
            }
            libraries.delete(oldAvatar);
            const settings = ctx().extensionSettings[KEY] ??= {};
            if (settings?.index) delete settings.index[oldAvatar];
            // 추가 이미지가 없어도 과거 채팅의 원본 고정 선택을 이전 이름으로 읽는다.
            const renamed = settings.renamed ??= {};
            for (const key of Object.keys(renamed)) if (renamed[key] === oldAvatar) renamed[key] = newAvatar;
            delete renamed[newAvatar];
            renamed[oldAvatar] = newAvatar;
            await saveLocalSettings();
        }));
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
    document.addEventListener('scroll', e => { if (picker && !picker.contains(e.target)) closePicker(); }, true);
    window.addEventListener('resize', () => closePicker());

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
