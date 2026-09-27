import { EventEmitter } from 'events';
import * as cp from 'child_process';
import { runCli, parseCliJson, cliErrorText } from './cli';
import * as salesforceIndex from './index';

type MockProc = EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
};

function createMockProc(): MockProc {
    const proc = new EventEmitter() as MockProc;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    return proc;
}

describe('runCli', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('passes cwd and returns stdout and stderr on exit 1', async () => {
        const proc = createMockProc();
        const spawnSpy = jest.spyOn(cp, 'spawn').mockImplementation((() => {
            setImmediate(() => {
                proc.stdout.emit('data', Buffer.from('out'));
                proc.stderr.emit('data', Buffer.from('err'));
                proc.emit('close', 1);
            });
            return proc as unknown as cp.ChildProcessWithoutNullStreams;
        }) as unknown as typeof cp.spawn);
        const result = await runCli(['org', 'display'], 'C:/root');
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        expect(spawnSpy.mock.calls[0][2]).toEqual(expect.objectContaining({ cwd: 'C:/root' }));
        expect(result.stdout).toBe('out');
        expect(result.stderr).toBe('err');
        expect(result.exitCode).toBe(1);
        expect(result.args).toEqual(['org', 'display']);
        expect(typeof result.startTime).toBe('string');
    });

    it('uses cmd.exe routing on Windows with discrete args and shell false', async () => {
        const proc = createMockProc();
        const spawnSpy = jest.spyOn(cp, 'spawn').mockImplementation((() => {
            setImmediate(() => {
                proc.emit('close', 0);
            });
            return proc as unknown as cp.ChildProcessWithoutNullStreams;
        }) as unknown as typeof cp.spawn);
        await runCli(['org', 'display', 'C:/path with spaces'], 'C:/root');
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        const [file, spawnArgs, options] = spawnSpy.mock.calls[0] as unknown as [string, string[], cp.SpawnOptions];
        if (process.platform === 'win32') {
            expect(file).toBe('cmd.exe');
            expect(spawnArgs).toEqual(['/c', 'sf.cmd', 'org', 'display', 'C:/path with spaces']);
        } else {
            expect(file).toBe('sf');
            expect(spawnArgs).toEqual(['org', 'display', 'C:/path with spaces']);
        }
        expect(options).toEqual(expect.objectContaining({ cwd: 'C:/root', shell: false }));
        expect(spawnArgs).not.toContain('org display');
    });

    it('rejects with install hint on launch error', async () => {
        const proc = createMockProc();
        jest.spyOn(cp, 'spawn').mockImplementation((() => {
            setImmediate(() => {
                proc.emit('error', new Error('spawn ENOENT'));
            });
            return proc as unknown as cp.ChildProcessWithoutNullStreams;
        }) as unknown as typeof cp.spawn);
        await expect(runCli(['org'], 'C:/root')).rejects.toThrow('spawn ENOENT (is the Salesforce CLI installed?)');
    });

    it('kills and rejects on timeout', async () => {
        const proc = createMockProc();
        jest.spyOn(cp, 'spawn').mockImplementation((() => {
            return proc as unknown as cp.ChildProcessWithoutNullStreams;
        }) as unknown as typeof cp.spawn);
        await expect(runCli(['org'], 'C:/root', { timeoutMs: 20 })).rejects.toThrow('sf timed out after 20ms');
        expect(proc.kill).toHaveBeenCalledTimes(1);
    });
});

describe('parseCliJson', () => {
    it('parses plain JSON', () => {
        expect(parseCliJson<{ status: number }>('{"status":0}', ['org'])).toEqual({ status: 0 });
    });

    it('skips warning preamble before JSON object', () => {
        expect(parseCliJson<{ status: number }>('warning\n{"status":0}', ['org'])).toEqual({ status: 0 });
    });
});

describe('cliErrorText', () => {
    it('extracts message from JSON stdout when stderr is advisory', () => {
        expect(cliErrorText('Warning: update available', '{"message":"bad org"}', 1)).toBe('bad org');
    });

    it('extracts result.message and name from JSON stdout', () => {
        expect(cliErrorText('', '{"result":{"message":"inner"}}', 1)).toBe('inner');
        expect(cliErrorText('', '{"name":"NamedError"}', 1)).toBe('NamedError');
    });

    it('returns meaningful stderr when present', () => {
        expect(cliErrorText('real failure', '{"message":"bad org"}', 1)).toBe('real failure');
    });
});

describe('salesforce exports', () => {
    it('exposes runner, parser, and error helper', () => {
        expect(salesforceIndex.runCli).toBe(runCli);
        expect(salesforceIndex.parseCliJson).toBe(parseCliJson);
        expect(salesforceIndex.cliErrorText).toBe(cliErrorText);
    });

    it('exposes salesforce namespace from package index', async () => {
        const pkg = await import('../index');
        expect(pkg.salesforce.runCli).toBe(runCli);
        expect(pkg.salesforce.parseCliJson).toBe(parseCliJson);
        expect(pkg.salesforce.cliErrorText).toBe(cliErrorText);
    });
});
