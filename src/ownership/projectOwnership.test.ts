import * as childProcess from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

interface OwnershipHandle {
    readonly applicationId: string;
    readonly projectKey: string;
    readonly port: number;
    readonly closed: Promise<Error>;
    release(): Promise<void>;
}

type OwnershipApi = {
    resolveProjectOwnershipIdentity(options: { applicationId: string; projectRoot: string }): Promise<{ projectKey: string; port: number }>;
    acquireProjectOwnership(options: { applicationId: string; projectRoot: string }): Promise<
        | { status: 'acquired'; ownership: OwnershipHandle }
        | { status: 'conflict' }
        | { status: 'error'; error: Error }
    >;
};

const ownershipExport = (require('../index') as { ownership?: OwnershipApi }).ownership;
const api = ownershipExport as OwnershipApi;
const childScript = `
const api = require(process.argv[1]).ownership;
api.acquireProjectOwnership({ applicationId: process.argv[2], projectRoot: process.argv[3] }).then((result) => {
  process.stdout.write(JSON.stringify(result.status === 'acquired'
    ? { status: result.status, port: result.ownership.port, projectKey: result.ownership.projectKey }
    : result) + '\\n');
  if (result.status === 'acquired') {
    process.stdin.once('data', () => result.ownership.release().then(() => process.exit(0)));
  } else {
    process.exitCode = result.status === 'error' ? 2 : 0;
  }
}).catch((error) => { process.stderr.write(String(error)); process.exit(3); });
`;

let tempDirs: string[] = [];
let children: childProcess.ChildProcess[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-core-owner-'));
    tempDirs.push(dir);
    return dir;
}

function launchChild(applicationId: string, projectRoot: string): Promise<{
    child: childProcess.ChildProcess;
    result: { status: string; port?: number; projectKey?: string; error?: string };
}> {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(process.execPath, [
            '-e', childScript,
            path.resolve(__dirname, '../../dist/index.js'),
            applicationId,
            projectRoot,
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        children.push(child);
        let output = '';
        let errors = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            output += chunk;
            const newline = output.indexOf('\n');
            if (newline !== -1) {
                try {
                    resolve({ child, result: JSON.parse(output.slice(0, newline)) as { status: string; port?: number; projectKey?: string } });
                } catch (error) {
                    reject(error);
                }
            }
        });
        child.stderr?.on('data', (chunk: string) => { errors += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (output.indexOf('\n') === -1) reject(new Error(`Child exited before result (${code}): ${errors}`));
        });
    });
}

async function stopChild(child: childProcess.ChildProcess, crash = false): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const onExit = (): void => resolveExit();
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
        child.removeListener('exit', onExit);
        return;
    }
    if (crash) child.kill();
    else child.stdin?.write('release');

    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), 3000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!timedOut) return;

    child.kill();
    timer = undefined;
    const killedInTime = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3000); }),
    ]);
    if (timer) clearTimeout(timer);
    child.removeListener('exit', onExit);
    if (!killedInTime) throw new Error('Ownership child did not exit after kill');
    throw new Error('Ownership child did not exit promptly and was killed');
}

async function listen(port: number): Promise<net.Server> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true, reusePort: false }, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    return server;
}

async function portIsFree(port: number): Promise<boolean> {
    try {
        const server = await listen(port);
        await promisify(server.close.bind(server))();
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return false;
        throw error;
    }
}

beforeEach(() => {
    tempDirs = [];
    children = [];
});

afterEach(async () => {
    const cleanupErrors: Error[] = [];
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
            try { await stopChild(child, true); } catch (error) {
                cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    if (cleanupErrors.length > 0) throw new Error(`Failed to stop ownership child process: ${cleanupErrors.map((error) => error.message).join('; ')}`);
});

describe('project ownership', () => {
    test('exports the approved API and maps physical roots to stable namespaced ports', async () => {
        expect(ownershipExport).toBeDefined();
        const root = tempDir();
        const first = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root });
        const second = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root });
        expect(first).toEqual(second);
        expect(first.port).toBeGreaterThanOrEqual(20000);
        expect(first.port).toBeLessThanOrEqual(29999);
        expect(first.projectKey).not.toContain(root);
    });

    test('uses case-insensitive identity for Windows roots', async () => {
        if (process.platform !== 'win32') return;
        const root = tempDir();
        const lower = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root.toLowerCase() });
        const upper = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root.toUpperCase() });
        expect(upper).toEqual(lower);
    });

    test('returns realpath failures as structured acquisition errors', async () => {
        const result = await api.acquireProjectOwnership({ applicationId: 'apexsense-lsp', projectRoot: path.join(tempDir(), 'missing') });
        expect(result.status).toBe('error');
        if (result.status === 'error') expect(result.error).toBeInstanceOf(Error);
    });

    test('only one independent process acquires a namespaced physical root', async () => {
        let root = tempDir();
        let identity = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root });
        for (let attempt = 0; attempt < 20 && !(await portIsFree(identity.port)); attempt++) {
            root = tempDir();
            identity = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root });
        }
        expect(await portIsFree(identity.port)).toBe(true);

        const launched: Array<{ child: childProcess.ChildProcess; result: { status: string; port?: number; projectKey?: string; error?: string } }> = [];
        try {
            const results = await Promise.all([
                launchChild('apexsense-lsp', root).then((result) => { launched.push(result); return result; }),
                launchChild('apexsense-lsp', root).then((result) => { launched.push(result); return result; }),
            ]);
            const statuses = results.map((result) => result.result.status).sort();
            expect(statuses).toEqual(['acquired', 'conflict']);
        } finally {
            await Promise.all(children.map((child) => {
                const completed = launched.find((result) => result.child === child);
                return stopChild(child, !completed || completed.result.status !== 'acquired');
            }));
        }
    });

    test('a crashed process releases its socket for a subsequent owner', async () => {
        const root = tempDir();
        const first = await launchChild('apexsense-lsp', root);
        expect(first.result.status).toBe('acquired');
        await stopChild(first.child, true);
        const next = await launchChild('apexsense-lsp', root);
        expect(next.result.status).toBe('acquired');
        await stopChild(next.child);
    });

    test('different roots can be acquired concurrently when their deterministic ports differ', async () => {
        const roots = [tempDir()];
        let identity = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: roots[0] });
        for (let attempt = 0; attempt < 12; attempt++) {
            const candidate = tempDir();
            const candidateIdentity = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: candidate });
            if (candidateIdentity.port !== identity.port) {
                roots.push(candidate);
                identity = candidateIdentity;
                break;
            }
        }
        expect(roots).toHaveLength(2);
        const acquired = await Promise.all(roots.map((projectRoot) => api.acquireProjectOwnership({ applicationId: 'apexsense-lsp', projectRoot })));
        expect(acquired.every((result) => result.status === 'acquired')).toBe(true);
        for (const result of acquired) if (result.status === 'acquired') await result.ownership.release();
    });

    test('symlink aliases resolve to the same identity when directory symlinks are supported', async () => {
        const root = tempDir();
        const alias = path.join(tempDir(), 'alias');
        try {
            fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            return;
        }
        const original = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root });
        const linked = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: alias });
        expect(linked).toEqual(original);
    });

    test('application namespaces choose independent ports where hashes do not collide', async () => {
        const root = tempDir();
        const base = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root });
        let otherApp = '';
        let other = base;
        for (let attempt = 0; attempt < 12; attempt++) {
            otherApp = `metawrench-${attempt}`;
            other = await api.resolveProjectOwnershipIdentity({ applicationId: otherApp, projectRoot: root });
            if (other.port !== base.port) break;
        }
        expect(other.port).not.toBe(base.port);
        const first = await api.acquireProjectOwnership({ applicationId: 'apexsense-lsp', projectRoot: root });
        const second = await api.acquireProjectOwnership({ applicationId: otherApp, projectRoot: root });
        expect(first.status).toBe('acquired');
        expect(second.status).toBe('acquired');
        if (first.status === 'acquired') await first.ownership.release();
        if (second.status === 'acquired') await second.ownership.release();
    });

    test('an unrelated listener on the derived port is a conflict', async () => {
        const root = tempDir();
        const identity = await api.resolveProjectOwnershipIdentity({ applicationId: 'apexsense-lsp', projectRoot: root });
        const unrelated = await listen(identity.port);
        try {
            await expect(api.acquireProjectOwnership({ applicationId: 'apexsense-lsp', projectRoot: root }))
                .resolves.toEqual({ status: 'conflict' });
        } finally {
            await promisify(unrelated.close.bind(unrelated))();
        }
    });

    test('release is idempotent and does not signal unexpected closure', async () => {
        const root = tempDir();
        const result = await api.acquireProjectOwnership({ applicationId: 'apexsense-lsp', projectRoot: root });
        expect(result.status).toBe('acquired');
        if (result.status !== 'acquired') return;
        await Promise.all([result.ownership.release(), result.ownership.release()]);
        expect(result.ownership.port).toBeGreaterThanOrEqual(20000);
        await expect(Promise.race([result.ownership.closed, Promise.resolve('pending')])).resolves.toBe('pending');
        const reacquired = await api.acquireProjectOwnership({ applicationId: 'apexsense-lsp', projectRoot: root });
        expect(reacquired.status).toBe('acquired');
        if (reacquired.status === 'acquired') await reacquired.ownership.release();
    });

    test('release completes while a local client keeps its connection idle', async () => {
        const root = tempDir();
        const result = await api.acquireProjectOwnership({ applicationId: 'apexsense-lsp', projectRoot: root });
        expect(result.status).toBe('acquired');
        if (result.status !== 'acquired') return;

        const client = net.connect(result.ownership.port, '127.0.0.1');
        let timer: NodeJS.Timeout | undefined;
        try {
            await once(client, 'connect');
            const outcome = await Promise.race([
                result.ownership.release().then(() => 'released'),
                new Promise<string>((resolve) => { timer = setTimeout(() => resolve('blocked'), 1500); }),
            ]);
            expect(outcome).toBe('released');
        } finally {
            if (timer) clearTimeout(timer);
            client.destroy();
            await result.ownership.release();
        }
    });

    test('unexpected close and error resolve closed with an Error', async () => {
        const originalCreateServer = net.createServer;
        let captured: net.Server | undefined;
        const spy = jest.spyOn(net, 'createServer').mockImplementation(((...args: Parameters<typeof net.createServer>) => {
            captured = originalCreateServer(...args);
            return captured;
        }) as typeof net.createServer);
        try {
            const closedResult = await api.acquireProjectOwnership({ applicationId: 'close-test', projectRoot: tempDir() });
            expect(closedResult.status).toBe('acquired');
            if (closedResult.status === 'acquired' && captured) {
                captured.close();
                await expect(closedResult.ownership.closed).resolves.toBeInstanceOf(Error);
                await closedResult.ownership.release();
            }
            const errorResult = await api.acquireProjectOwnership({ applicationId: 'error-test', projectRoot: tempDir() });
            expect(errorResult.status).toBe('acquired');
            if (errorResult.status === 'acquired' && captured) {
                captured.emit('error', new Error('unexpected test error'));
                await expect(errorResult.ownership.closed).resolves.toMatchObject({ message: 'unexpected test error' });
                await errorResult.ownership.release();
            }
        } finally {
            spy.mockRestore();
        }
    });
});
