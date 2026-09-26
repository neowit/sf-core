import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { TelemetryBatch } from './types';
import { createTelemetryStore } from './store';

// Delegating mock so async fs boundary ops can be failed on purpose per
// test; all calls delegate to the real implementation by default.
jest.mock('fs/promises', () => {
    const actual = jest.requireActual('fs/promises');
    return { ...actual };
});

// Module-namespace objects are frozen, so interception goes through the
// mutable mock registry object (same instance production uses).
const mockedFsPromises = jest.requireMock('fs/promises') as typeof fsPromises;
const actualFsPromises = jest.requireActual('fs/promises') as typeof fsPromises;

const ACTIONS = ['compile', 'navigate'] as const;
type TestAction = (typeof ACTIONS)[number];

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CLIENT_ID = '123e4567-e89b-42d3-a456-426614174001';

let tmpDirs: string[] = [];
let openStores: Array<{ shutdown(): Promise<void> }> = [];

function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-store-test-'));
    tmpDirs.push(dir);
    return dir;
}

function makeStore(
    dir: string,
    overrides?: Partial<{
        sessionId: string;
        clientId: string;
        os: string;
        appVersion: string;
        pid: number;
        debounceMs: number;
        isProcessAlive: (pid: number) => boolean;
    }>
) {
    const store = createTelemetryStore<TestAction>({
        stateDir: dir,
        sessionId: 'sess-test-one',
        clientId: CLIENT_ID,
        os: 'linux',
        appVersion: '9.9.9',
        pid: 4242,
        actions: ACTIONS,
        ...overrides,
    });
    openStores.push(store);
    return store;
}

function draftPath(dir: string, sessionId: string): string {
    return path.join(dir, 'telemetry', 'drafts', 'draft-' + sessionId + '.json');
}

function markerPath(dir: string, sessionId: string): string {
    return path.join(dir, 'telemetry', 'sessions', sessionId + '.json');
}

function pendingDir(dir: string): string {
    return path.join(dir, 'telemetry', 'pending');
}

function reapedPid(): number {
    const child = childProcess.spawnSync(process.execPath, ['-e', '']);
    expect(typeof child.pid).toBe('number');
    return child.pid as number;
}

function collectFileNames(root: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(root)) {
        return out;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectFileNames(full));
        } else {
            out.push(entry.name);
        }
    }
    return out;
}

beforeEach(() => {
    tmpDirs = [];
    openStores = [];
});

afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const store of openStores) {
        await store.shutdown();
    }
    openStores = [];
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
});

describe('draft persistence', () => {
    test('add then flush persists a six-field draft and a marker first', async () => {
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.add('compile');
        store.add('compile');
        store.add('navigate');
        expect(store.snapshot()).toEqual({ compile: 2, navigate: 1 });
        await store.flushDraft();

        const marker = markerPath(dir, 'sess-test-one');
        const draft = draftPath(dir, 'sess-test-one');
        expect(fs.existsSync(marker)).toBe(true);
        expect(fs.existsSync(draft)).toBe(true);
        expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ pid: 4242 });
        expect(fs.statSync(marker).mtimeMs).toBeLessThanOrEqual(fs.statSync(draft).mtimeMs);

        const parsed = JSON.parse(fs.readFileSync(draft, 'utf8'));
        expect(Object.keys(parsed).sort()).toEqual([
            'actionCounts',
            'appVersion',
            'batchId',
            'clientId',
            'os',
            'schemaVersion',
        ]);
        expect(parsed.schemaVersion).toBe(1);
        expect(parsed.batchId).toMatch(UUID_V4_RE);
        expect(parsed.clientId).toBe(CLIENT_ID);
        expect(parsed.os).toBe('linux');
        expect(parsed.appVersion).toBe('9.9.9');
        expect(parsed.actionCounts).toEqual({ compile: 2, navigate: 1 });
    });

    test('add debounces to a single delayed write', async () => {
        jest.useFakeTimers();
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.add('compile');
        store.add('compile');
        expect(fs.existsSync(draftPath(dir, 'sess-test-one'))).toBe(false);
        jest.advanceTimersByTime(1000);
        await store.flushDraft();
        const parsed = JSON.parse(fs.readFileSync(draftPath(dir, 'sess-test-one'), 'utf8'));
        expect(parsed.actionCounts).toEqual({ compile: 2 });
    });

    test('addMany validates counts and persists a bulk increment with the existing debounce', async () => {
        jest.useFakeTimers();
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.addMany('compile', 3);
        store.addMany('navigate', 2);
        store.addMany('compile', 0);
        store.addMany('compile', -1);
        store.addMany('compile', 1.5);
        store.addMany('compile', Number.MAX_SAFE_INTEGER + 1);
        store.addMany('unknown' as unknown as TestAction, 10);

        expect(store.snapshot()).toEqual({ compile: 3, navigate: 2 });
        expect(fs.existsSync(draftPath(dir, 'sess-test-one'))).toBe(false);
        jest.advanceTimersByTime(1000);
        await store.flushDraft();

        const parsed = JSON.parse(fs.readFileSync(draftPath(dir, 'sess-test-one'), 'utf8'));
        expect(parsed.actionCounts).toEqual({ compile: 3, navigate: 2 });
    });

    test('unknown actions are ignored and never persisted', async () => {
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.add('unknown' as unknown as TestAction);
        expect(store.snapshot()).toEqual({});
        await store.flushDraft();
        expect(fs.existsSync(draftPath(dir, 'sess-test-one'))).toBe(false);
    });
});

describe('orphan recovery', () => {
    test('dead session draft moves to pending with the same batch id', async () => {
        const dir = makeTmpDir();
        const first = makeStore(dir, {
            sessionId: 'sess-one',
            pid: reapedPid(),
            clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            os: 'linux',
            appVersion: '1.2.3',
        });
        first.add('compile');
        first.add('navigate');
        await first.flushDraft();
        const original = JSON.parse(fs.readFileSync(draftPath(dir, 'sess-one'), 'utf8'));
        expect(original.batchId).toMatch(UUID_V4_RE);

        const second = makeStore(dir, {
            sessionId: 'sess-two',
            isProcessAlive: () => false,
        });
        await second.recoverOrphanedDrafts();

        const pendingFile = path.join(pendingDir(dir), original.batchId + '.json');
        expect(fs.existsSync(pendingFile)).toBe(true);
        expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toEqual(original);
        expect(fs.existsSync(draftPath(dir, 'sess-one'))).toBe(false);
        expect(second.snapshot()).toEqual({});
        expect(fs.existsSync(markerPath(dir, 'sess-one'))).toBe(true);
    });

    test('live session draft is left untouched', async () => {
        const dir = makeTmpDir();
        const first = makeStore(dir, { sessionId: 'sess-one', pid: process.pid });
        first.add('compile');
        await first.flushDraft();
        const before = fs.readFileSync(draftPath(dir, 'sess-one'), 'utf8');

        const second = makeStore(dir, {
            sessionId: 'sess-two',
            isProcessAlive: () => true,
        });
        await second.recoverOrphanedDrafts();

        expect(fs.readFileSync(draftPath(dir, 'sess-one'), 'utf8')).toBe(before);
        expect(fs.existsSync(pendingDir(dir))).toBe(false);
    });

    test('throwing liveness probe fails closed', async () => {
        const dir = makeTmpDir();
        const first = makeStore(dir, { sessionId: 'sess-one', pid: reapedPid() });
        first.add('compile');
        await first.flushDraft();
        const before = fs.readFileSync(draftPath(dir, 'sess-one'), 'utf8');

        const second = makeStore(dir, {
            sessionId: 'sess-two',
            isProcessAlive: () => {
                throw new Error('probe down');
            },
        });
        await second.recoverOrphanedDrafts();

        expect(fs.readFileSync(draftPath(dir, 'sess-one'), 'utf8')).toBe(before);
        expect(fs.existsSync(pendingDir(dir))).toBe(false);
    });
});

describe('sealCurrentBatch', () => {
    test('seal moves the draft to pending and starts a fresh batch', async () => {
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.add('compile');
        store.add('navigate');
        const sealed = await store.sealCurrentBatch();
        expect(sealed).not.toBeNull();
        expect(sealed && sealed.batchId).toMatch(UUID_V4_RE);
        expect(sealed && sealed.actionCounts).toEqual({ compile: 1, navigate: 1 });

        const pendingFile = path.join(pendingDir(dir), (sealed as { batchId: string }).batchId + '.json');
        expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toEqual(sealed);
        expect(fs.existsSync(draftPath(dir, 'sess-test-one'))).toBe(false);
        expect(store.snapshot()).toEqual({});

        store.add('compile');
        await store.flushDraft();
        const next = JSON.parse(fs.readFileSync(draftPath(dir, 'sess-test-one'), 'utf8'));
        expect(next.batchId).toMatch(UUID_V4_RE);
        expect(next.batchId).not.toBe((sealed as { batchId: string }).batchId);

        expect(await store.sealCurrentBatch()).not.toBeNull();
        expect(await store.sealCurrentBatch()).toBeNull();
    });

    test('actions added at the seal rename boundary survive in the next batch', async () => {
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.add('compile');
        const pending = pendingDir(dir);
        const originalRename = actualFsPromises.rename;
        let boundaryHit = false;
        const spy = jest.spyOn(mockedFsPromises, 'rename').mockImplementation((async (
            source: any,
            destination: any
        ) => {
            if (
                !boundaryHit &&
                typeof destination === 'string' &&
                destination.startsWith(pending + path.sep)
            ) {
                boundaryHit = true;
                // A user action lands while sealing is awaiting the rename.
                store.add('navigate');
            }
            return (originalRename as any)(source, destination);
        }) as typeof fsPromises.rename);
        let sealed: TelemetryBatch<TestAction> | null;
        try {
            sealed = await store.sealCurrentBatch();
        } finally {
            spy.mockRestore();
        }
        expect(boundaryHit).toBe(true);
        expect(sealed).not.toBeNull();
        const sealedBatch = sealed as TelemetryBatch<TestAction>;
        const onDisk = JSON.parse(
            fs.readFileSync(path.join(pending, sealedBatch.batchId + '.json'), 'utf8')
        );
        expect(onDisk).toEqual(sealedBatch);
        expect(onDisk.actionCounts).toEqual({ compile: 1 });
        expect(store.snapshot()).toEqual({ navigate: 1 });
        await store.flushDraft();
        const nextDraft = JSON.parse(
            fs.readFileSync(draftPath(dir, 'sess-test-one'), 'utf8')
        );
        expect(nextDraft.actionCounts).toEqual({ navigate: 1 });
        expect(nextDraft.batchId).not.toBe(sealedBatch.batchId);
    });

    test('failed persistence keeps counts and draft and returns null', async () => {
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.add('compile');
        await store.flushDraft();
        const draftBefore = fs.readFileSync(draftPath(dir, 'sess-test-one'), 'utf8');

        const spy = jest.spyOn(mockedFsPromises, 'writeFile').mockImplementation((async (
            target: any,
            ...rest: any[]
        ) => {
            if (
                typeof target === 'string' &&
                (target.includes(path.sep + 'drafts' + path.sep) ||
                    target.includes(path.sep + 'pending' + path.sep))
            ) {
                const err = new Error('EIO') as NodeJS.ErrnoException;
                err.code = 'EIO';
                throw err;
            }
            return (actualFsPromises.writeFile as any)(target, ...rest);
        }) as typeof fsPromises.writeFile);
        try {
            store.add('navigate');
            expect(await store.sealCurrentBatch()).toBeNull();
        } finally {
            spy.mockRestore();
        }

        expect(store.snapshot()).toEqual({ compile: 1, navigate: 1 });
        expect(fs.readFileSync(draftPath(dir, 'sess-test-one'), 'utf8')).toBe(draftBefore);

        const sealed = await store.sealCurrentBatch();
        expect(sealed && sealed.actionCounts).toEqual({ compile: 1, navigate: 1 });
    });
});

describe('quarantine', () => {
    test('corrupt draft is quarantined and unrelated files kept', async () => {
        const dir = makeTmpDir();
        const drafts = path.join(dir, 'telemetry', 'drafts');
        fs.mkdirSync(drafts, { recursive: true });
        fs.writeFileSync(path.join(drafts, 'draft-old.json'), '{oops', 'utf8');
        fs.writeFileSync(path.join(drafts, 'notes.txt'), 'hello', 'utf8');

        const store = makeStore(dir, {
            sessionId: 'sess-two',
            isProcessAlive: () => false,
        });
        await store.recoverOrphanedDrafts();

        expect(fs.existsSync(path.join(drafts, 'draft-old.json'))).toBe(false);
        expect(fs.existsSync(path.join(drafts, 'draft-old.json.corrupt'))).toBe(true);
        expect(fs.readFileSync(path.join(drafts, 'notes.txt'), 'utf8')).toBe('hello');
        expect(fs.existsSync(pendingDir(dir))).toBe(false);
    });

    test('corrupt pending is quarantined and unrelated files kept', async () => {
        const dir = makeTmpDir();
        const pending = pendingDir(dir);
        fs.mkdirSync(pending, { recursive: true });
        const goodId = '123e4567-e89b-42d3-a456-426614174002';
        const good = {
            schemaVersion: 1,
            batchId: goodId,
            clientId: CLIENT_ID,
            os: 'linux',
            appVersion: '9.9.9',
            actionCounts: { compile: 3 },
        };
        fs.writeFileSync(path.join(pending, goodId + '.json'), JSON.stringify(good), 'utf8');
        fs.writeFileSync(path.join(pending, 'bad.json'), '{oops', 'utf8');
        fs.writeFileSync(path.join(pending, 'notes.txt'), 'hello', 'utf8');

        const store = makeStore(dir);
        const batches = await store.listPendingBatches();

        expect(batches).toEqual([good]);
        expect(fs.existsSync(path.join(pending, 'bad.json'))).toBe(false);
        expect(fs.existsSync(path.join(pending, 'bad.json.corrupt'))).toBe(true);
        expect(fs.readFileSync(path.join(pending, 'notes.txt'), 'utf8')).toBe('hello');
    });

    test('valid payload under a mismatched filename is quarantined, never listed', async () => {
        const dir = makeTmpDir();
        const pending = pendingDir(dir);
        fs.mkdirSync(pending, { recursive: true });
        const goodId = '123e4567-e89b-42d3-a456-426614174002';
        const good = {
            schemaVersion: 1,
            batchId: goodId,
            clientId: CLIENT_ID,
            os: 'linux',
            appVersion: '9.9.9',
            actionCounts: { compile: 3 },
        };
        const strayId = '123e4567-e89b-42d3-a456-426614174004';
        const stray = { ...good, batchId: strayId };
        fs.writeFileSync(path.join(pending, goodId + '.json'), JSON.stringify(good), 'utf8');
        fs.writeFileSync(path.join(pending, 'wrong-name.json'), JSON.stringify(stray), 'utf8');
        fs.writeFileSync(path.join(pending, 'notes.txt'), 'hello', 'utf8');

        const store = makeStore(dir);
        const batches = await store.listPendingBatches();

        expect(batches).toEqual([good]);
        expect(fs.existsSync(path.join(pending, 'wrong-name.json'))).toBe(false);
        expect(fs.existsSync(path.join(pending, 'wrong-name.json.corrupt'))).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(pending, goodId + '.json'), 'utf8'))).toEqual(
            good
        );
        expect(fs.readFileSync(path.join(pending, 'notes.txt'), 'utf8')).toBe('hello');
    });
});

describe('atomic writes and deletion', () => {
    test('no tmp file remains after successful writes', async () => {
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.add('compile');
        await store.flushDraft();
        expect(await store.sealCurrentBatch()).not.toBeNull();
        store.add('navigate');
        await store.flushDraft();
        const names = collectFileNames(path.join(dir, 'telemetry'));
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            expect(name).not.toContain('.tmp-');
        }
    });

    test('deletePendingBatch removes only safe names', async () => {
        const dir = makeTmpDir();
        const pending = pendingDir(dir);
        fs.mkdirSync(pending, { recursive: true });
        const goodId = '123e4567-e89b-42d3-a456-426614174003';
        const sibling = path.join(pending, 'keep.json');
        fs.writeFileSync(path.join(pending, goodId + '.json'), '{}', 'utf8');
        fs.writeFileSync(sibling, '{}', 'utf8');

        const store = makeStore(dir);
        await store.deletePendingBatch(goodId);
        expect(fs.existsSync(path.join(pending, goodId + '.json'))).toBe(false);
        await store.deletePendingBatch('../evil');
        await store.deletePendingBatch('');
        await store.deletePendingBatch('not-a-uuid');
        expect(fs.readFileSync(sibling, 'utf8')).toBe('{}');
    });
});

describe('shutdown', () => {
    test('shutdown flushes the draft and removes only its marker', async () => {
        const dir = makeTmpDir();
        const store = makeStore(dir);
        store.add('compile');
        await store.shutdown();
        expect(JSON.parse(fs.readFileSync(draftPath(dir, 'sess-test-one'), 'utf8')).actionCounts).toEqual({
            compile: 1,
        });
        expect(fs.existsSync(markerPath(dir, 'sess-test-one'))).toBe(false);
        await store.shutdown();
    });

    test('shutdown without any activity never throws', async () => {
        const dir = makeTmpDir();
        const store = makeStore(dir);
        await store.shutdown();
        expect(fs.existsSync(draftPath(dir, 'sess-test-one'))).toBe(false);
    });
});

describe('production implementation constraints', () => {
    test('uses async filesystem apis only and unrefs timers', () => {
        const source = fs.readFileSync(path.join(__dirname, 'store.ts'), 'utf8');
        for (const marker of [
            'readFileSync',
            'writeFileSync',
            'mkdirSync',
            'rmSync',
            'existsSync',
            'statSync',
            'readdirSync',
            'unlinkSync',
        ]) {
            expect(source).not.toContain(marker);
        }
        expect(source).toContain('unref');
    });
});
