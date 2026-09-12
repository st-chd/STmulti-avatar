const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const host = fs.readFileSync(path.resolve(root, '../../../../public/scripts/extensions.js'), 'utf8');
const start = host.indexOf('export async function writeExtensionFieldBulk(');
const bulk = host.slice(start, host.indexOf('\n}', start) + 2).replace('export ', '');

function setup({ failBulk = false } = {}) {
    const card = { avatar: 'Dr. Watson.png', data: { extensions: { multiAvatar: {
        dir: 'Dr. Watson_avatar', files: ['Dr_add1.png'], list: 'Dr_add1.png',
    } } } };
    const diskCard = structuredClone(card);
    const requests = [];
    const c = {
        characters: [card], constants: { unset: '__@@UNSET@@__' }, extensionSettings: {},
        chatMetadata: { unrelated: 42, multiAvatar: { [card.avatar]: 'Dr_add1.png' } },
        getRequestHeaders: () => ({}), saveSettingsDebounced() {}, async saveMetadata() {},
        updateChatMetadata(values, reset) { c.chatMetadata = reset ? { ...values } : { ...c.chatMetadata, ...values }; },
    };
    const sandbox = vm.createContext({
        SillyTavern: { getContext: () => c }, getContext: () => c,
        getRequestHeaders: c.getRequestHeaders, UNSET_VALUE: c.constants.unset,
        deleteValueByPath(obj) { delete obj.data.extensions.multiAvatar; },
        setValueByPath(obj, key, value) { obj.data.extensions.multiAvatar = value; },
        jQuery() {}, console, URL, location: { origin: 'http://localhost' },
        document: { getElementById: () => null },
        fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push({ url, body });
            let result = [];
            if (url === '/api/characters/merge-attributes') {
                if (failBulk) return { ok: false, status: 500, statusText: 'Failed' };
                if (body.data.data.extensions.multiAvatar === c.constants.unset) delete diskCard.data.extensions.multiAvatar;
                result = { updated: [card.avatar], failed: [], skipped: [] };
            }
            return { ok: true, json: async () => result };
        },
    });
    vm.runInContext(bulk, sandbox);
    c.writeExtensionFieldBulk = sandbox.writeExtensionFieldBulk;
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace('export async function cleanUp', 'async function cleanUp'), sandbox);
    return { sandbox, c, diskCard, requests };
}

test('cleanup deletes persisted card data, so reinstall cannot revive missing images', async () => {
    const { sandbox, diskCard } = setup();
    await vm.runInContext('cleanUp()', sandbox);
    assert.equal(Object.hasOwn(diskCard.data.extensions, 'multiAvatar'), false);
});

test('purge removes current chat key and preserves unrelated metadata', async () => {
    const { sandbox, c } = setup();
    await vm.runInContext('purgeAll(() => {})', sandbox);
    assert.equal(Object.hasOwn(c.chatMetadata, 'multiAvatar'), false);
    assert.equal(c.chatMetadata.unrelated, 42);
});

test('cleanup reports failed card persistence', async () => {
    const { sandbox } = setup({ failBulk: true });
    await assert.rejects(vm.runInContext('cleanUp()', sandbox));
});

test('upload keeps dotted names in its filename stem', () => {
    const { sandbox } = setup();
    // Evaluate the actual filename expression used by addImage.
    const expression = source.match(/const base = (dir\.[^;]+);/)[1];
    const base = vm.runInContext(`(() => { const dir = dirOf('Dr. Watson.png'); return ${expression}; })()`, sandbox);
    assert.equal(base, 'Dr_ Watson_avatar');
});

for (const neverResize of [true, false]) test(`upload respects never_resize_avatars=${neverResize}`, async () => {
    const { sandbox, c } = setup();
    let shown = 0;
    let actualCrop;
    c.powerUserSettings = { never_resize_avatars: neverResize };
    c.POPUP_TYPE = { CROP: 1 };
    c.Popup = class {
        cropData = { width: 200, height: 300 };
        async show() { shown++; return true; }
    };
    c.writeExtensionField = async () => {};
    sandbox.recordCrop = crop => { actualCrop = crop; };
    const originalFetch = sandbox.fetch;
    sandbox.fetch = async (url, options) => url === '/api/images/upload'
        ? { ok: true, json: async () => ({ path: 'user/images/Dr. Watson_avatar/Dr_ Watson_avatar_add1.png' }) }
        : originalFetch(url, options);
    sandbox.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,test'; this.onload(); } };
    vm.runInContext(`pickFile = async () => ({});
        cropToPng = async (data, crop) => { recordCrop(crop); return 'test'; };
        renderStrip = () => {}; refresh = () => {};`, sandbox);
    await vm.runInContext("uploadImage('Dr. Watson.png')", sandbox);
    assert.equal(shown, neverResize ? 0 : 1);
    assert.equal(actualCrop?.width, neverResize ? undefined : 200);
});

test('failed image probes are reused instead of requesting on every render', async () => {
    const { sandbox } = setup();
    let requests = 0;
    sandbox.Image = class { set src(value) { requests++; this.onerror(); } };
    for (let i = 0; i < 100; i++) assert.equal(await vm.runInContext("probe('/missing.png')", sandbox), false);
    assert.equal(requests, 1);
});

test('failed replacement does not rewrite original src and retrigger the preview observer', async () => {
    const { sandbox } = setup();
    let writes = 0;
    const src = '/thumbnail?type=avatar&file=Dr.%20Watson.png';
    const img = {
        dataset: {}, isConnected: true, closest: () => null,
        getAttribute: () => src,
        set src(value) { writes++; },
    };
    sandbox.Image = class { set src(value) { this.onerror(); } };
    sandbox.previewRoot = { querySelectorAll: () => [img] };
    vm.runInContext("swap(previewRoot, 'list')", sandbox);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 0);
});

test('path validation allows dotted names but blocks traversal', () => {
    const { sandbox } = setup();
    vm.runInContext("assertPathPart('J.R.R. Tolkien_avatar')", sandbox);
    for (const value of ['..', '../other', 'folder/file', 'folder\\file']) {
        sandbox.invalidPath = value;
        assert.throws(() => vm.runInContext('assertPathPart(invalidPath)', sandbox));
    }
});

test('deleting last persona entry removes empty settings containers', async () => {
    const { sandbox, c } = setup();
    c.extensionSettings.multiAvatar = { personas: { 'user.png': { files: ['a.png'] } } };
    await vm.runInContext("writeCard('persona:user.png', undefined)", sandbox);
    assert.equal(Object.hasOwn(c.extensionSettings, 'multiAvatar'), false);
});

test('purge loads shallow cards before deleting their images', async () => {
    const { sandbox, c, requests } = setup();
    const data = c.characters[0].data;
    c.characters[0].shallow = true;
    delete c.characters[0].data;
    c.unshallowCharacter = async id => { c.characters[id].data = data; c.characters[id].shallow = false; };
    await vm.runInContext('purgeAll(() => {})', sandbox);
    assert.ok(requests.some(r => r.url === '/api/images/delete' && r.body.path.endsWith('/Dr_add1.png')));
});

test('unsupported removal API fails before deleting images', async () => {
    const { sandbox, c, requests } = setup();
    delete c.constants;
    await assert.rejects(vm.runInContext('cleanUp()', sandbox));
    assert.equal(requests.length, 0);
});
