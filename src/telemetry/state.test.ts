import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    isProcessAlive,
    loadOrCreateClientId,
    purgeTelemetryState,
} from './state';

// Delegating mock so async fs boundary ops (rename) can be intercepted
// per test; all calls delegate to the real implementation by default.
jest.mock('fs/promises', () => {
    const actual = jest.requireActual('fs/promises');
    return { ...actual };
});

// Module-namespace objects are frozen, so boundary interception goes
// through the mutable mock registry object (same instance production uses).
const mockedFsPromises = jest.requireMock('fs/promises') as typeof fsPromises;
const actualFsPromises = jest.requireActual('fs/promises') as typeof fsPromises;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tmpDirs: string[] = [];

function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-state-test-'));
    tmpDirs.push(dir);
    return dir;
}

beforeEach(() => {
    tmpDirs = [];
});

afterEach(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
});

describe('loadOrCreateClientId', () => {
    test('creates on first call and reuses on second call', async () => {
        const dir = makeTmpDir();
        const first = await loadOrCreateClientId(dir);
        expect(first).toMatch(UUID_V4_RE);
        const raw = fs.readFileSync(path.join(dir, 'client-id'), 'utf8');
        expect(raw.trim()).toBe(first);
        const second = await loadOrCreateClientId(dir);
        expect(second).toBe(first);
    });

    test('recovers a corrupt id without modifying the legacy file', async () => {
        const dir = makeTmpDir();
        const filePath = path.join(dir, 'client-id');
        const recoveredPath = path.join(dir, 'client-id.recovered');
        fs.writeFileSync(filePath, 'not-a-uuid', 'utf8');
        const id = await loadOrCreateClientId(dir);
        expect(id).toMatch(UUID_V4_RE);
        expect(id).not.toBe('not-a-uuid');
        expect(fs.readFileSync(filePath, 'utf8')).toBe('not-a-uuid');
        expect(fs.readFileSync(recoveredPath, 'utf8').trim()).toBe(id);
    });

    test('concurrent first-create calls converge to one uuid', async () => {
        const dir = makeTmpDir();
        const results = await Promise.all(
            Array.from({ length: 8 }, () => loadOrCreateClientId(dir))
        );
        for (const id of results) {
            expect(id).toMatch(UUID_V4_RE);
        }
        const unique = new Set(results);
        expect(unique.size).toBe(1);
        expect(fs.readFileSync(path.join(dir, 'client-id'), 'utf8').trim()).toBe(results[0]);
    });

    test('concurrent calls never clobber an existing valid id', async () => {
        const dir = makeTmpDir();
        const seeded = await loadOrCreateClientId(dir);
        const results = await Promise.all(
            Array.from({ length: 8 }, () => loadOrCreateClientId(dir))
        );
        for (const id of results) {
            expect(id).toBe(seeded);
        }
    });

    test('concurrent corrupt recovery calls converge on one immutable winner', async () => {
        const dir = makeTmpDir();
        const filePath = path.join(dir, 'client-id');
        const recoveredPath = path.join(dir, 'client-id.recovered');
        fs.writeFileSync(filePath, 'not-a-uuid', 'utf8');
        const results = await Promise.all(
            Array.from({ length: 8 }, () => loadOrCreateClientId(dir))
        );
        expect(results.every((id) => id !== null && UUID_V4_RE.test(id))).toBe(true);
        expect(new Set(results).size).toBe(1);
        expect(fs.readFileSync(recoveredPath, 'utf8').trim()).toBe(results[0]);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('not-a-uuid');
    });

    test('fails closed when publishing the recovered id hard link fails', async () => {
        const dir = makeTmpDir();
        const filePath = path.join(dir, 'client-id');
        fs.writeFileSync(filePath, 'not-a-uuid', 'utf8');
        const spy = jest.spyOn(mockedFsPromises, 'link').mockRejectedValue(
            Object.assign(new Error('link denied'), { code: 'EPERM' })
        );
        try {
            await expect(loadOrCreateClientId(dir)).resolves.toBeNull();
        } finally {
            spy.mockRestore();
        }
        expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toHaveLength(0);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('not-a-uuid');
    });

    test.each(['', String(childProcess.spawnSync(process.execPath, ['-e', '']).pid), String(process.pid)])(
        'ignores and preserves legacy lock content %p during recovery',
        async (lockContent) => {
            const dir = makeTmpDir();
            const filePath = path.join(dir, 'client-id');
            const lockFile = path.join(dir, 'client-id.lock');
            fs.writeFileSync(filePath, 'not-a-uuid', 'utf8');
            fs.writeFileSync(lockFile, lockContent, 'utf8');
            const originalUnlink = actualFsPromises.unlink;
            const spy = jest.spyOn(mockedFsPromises, 'unlink').mockImplementation((async (
                target: any,
                ...rest: any[]
            ) => {
                expect(target).not.toBe(lockFile);
                return (originalUnlink as any)(target, ...rest);
            }) as typeof fsPromises.unlink);
            try {
                const result = await loadOrCreateClientId(dir);
                expect(result).toMatch(UUID_V4_RE);
            } finally {
                spy.mockRestore();
            }
            expect(fs.readFileSync(lockFile, 'utf8')).toBe(lockContent);
            expect(fs.readFileSync(filePath, 'utf8')).toBe('not-a-uuid');
        }
    );

    test('fails closed when the recovered winner cannot be read', async () => {
        const dir = makeTmpDir();
        const filePath = path.join(dir, 'client-id');
        const recoveredPath = path.join(dir, 'client-id.recovered');
        fs.writeFileSync(filePath, 'not-a-uuid', 'utf8');
        fs.writeFileSync(recoveredPath, '2e50fc60-f24f-4c89-b6d7-645251373231', 'utf8');
        const originalReadFile = actualFsPromises.readFile;
        const spy = jest.spyOn(mockedFsPromises, 'readFile').mockImplementation((async (
            target: any,
            ...rest: any[]
        ) => {
            if (target === recoveredPath) {
                throw new Error('read denied');
            }
            return (originalReadFile as any)(target, ...rest);
        }) as typeof fsPromises.readFile);
        try {
            await expect(loadOrCreateClientId(dir)).resolves.toBeNull();
        } finally {
            spy.mockRestore();
        }
        expect(fs.readFileSync(filePath, 'utf8')).toBe('not-a-uuid');
        expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toHaveLength(0);
    });

    test('purge removes recovered ids and legacy locks', async () => {
        const dir = makeTmpDir();
        const filePath = path.join(dir, 'client-id');
        const recoveredPath = path.join(dir, 'client-id.recovered');
        const lockFile = path.join(dir, 'client-id.lock');
        fs.writeFileSync(filePath, 'not-a-uuid', 'utf8');
        fs.writeFileSync(recoveredPath, '2e50fc60-f24f-4c89-b6d7-645251373231', 'utf8');
        fs.writeFileSync(lockFile, String(process.pid), 'utf8');
        await purgeTelemetryState(dir);
        expect(fs.existsSync(lockFile)).toBe(false);
        expect(fs.existsSync(filePath)).toBe(false);
        expect(fs.existsSync(recoveredPath)).toBe(false);
        const id = await loadOrCreateClientId(dir);
        expect(id).toMatch(UUID_V4_RE);
        expect(fs.readFileSync(filePath, 'utf8').trim()).toBe(id);
    });

    test('unusable state dir resolves null instead of rejecting', async () => {
        const dir = makeTmpDir();
        const filePath = path.join(dir, 'not-a-dir');
        fs.writeFileSync(filePath, 'x', 'utf8');
        await expect(loadOrCreateClientId(filePath)).resolves.toBeNull();
        await expect(
            loadOrCreateClientId(path.join(filePath, 'subdir'))
        ).resolves.toBeNull();
    });
});

describe('purgeTelemetryState', () => {
    test('removes only telemetry state and a re-create yields a different id', async () => {
        const dir = makeTmpDir();
        const first = await loadOrCreateClientId(dir);
        expect(first).toMatch(UUID_V4_RE);
        const draftDir = path.join(dir, 'telemetry', 'drafts');
        fs.mkdirSync(draftDir, { recursive: true });
        fs.writeFileSync(path.join(draftDir, 'draft.json'), '{}', 'utf8');
        const sibling = path.join(dir, 'baselines.json');
        fs.writeFileSync(sibling, '{"kept":true}', 'utf8');

        await purgeTelemetryState(dir);

        expect(fs.existsSync(path.join(dir, 'client-id'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'telemetry'))).toBe(false);
        expect(fs.readFileSync(sibling, 'utf8')).toBe('{"kept":true}');

        const second = await loadOrCreateClientId(dir);
        expect(second).toMatch(UUID_V4_RE);
        expect(second).not.toBe(first);
    });

    test('never throws for a missing dir', async () => {
        const dir = path.join(makeTmpDir(), 'missing');
        await expect(purgeTelemetryState(dir)).resolves.toBeUndefined();
    });
});

describe('isProcessAlive', () => {
    test('current pid is alive and an exited child pid is not', () => {
        expect(isProcessAlive(process.pid)).toBe(true);
        const result = childProcess.spawnSync(process.execPath, ['-e', '']);
        expect(typeof result.pid).toBe('number');
        expect(result.pid).not.toBe(process.pid);
        expect(isProcessAlive(result.pid)).toBe(false);
    });

    test('eperm and unknown probe errors count as alive', () => {
        const originalKill = process.kill;
        try {
            (process as unknown as { kill: (pid: number, signal?: number) => void }).kill = () => {
                const err = new Error('forbidden') as NodeJS.ErrnoException;
                err.code = 'EPERM';
                throw err;
            };
            expect(isProcessAlive(123456)).toBe(true);
            (process as unknown as { kill: (pid: number, signal?: number) => void }).kill = () => {
                const err = new Error('weird') as NodeJS.ErrnoException;
                err.code = 'EUNKNOWN';
                throw err;
            };
            expect(isProcessAlive(123456)).toBe(true);
        } finally {
            (process as unknown as { kill: typeof process.kill }).kill = originalKill;
        }
    });
});

describe('production implementation constraints', () => {
    test('uses async filesystem apis only', () => {
        const source = fs.readFileSync(path.join(__dirname, 'state.ts'), 'utf8');
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
    });
});
