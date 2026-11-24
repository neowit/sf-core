import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli, parseCliJson, cliErrorText, escapeWindowsCmdArgument, windowsCmdArgs } from './cli';
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
            expect(spawnArgs).toEqual(windowsCmdArgs(['org', 'display', 'C:/path with spaces']));
            expect(spawnArgs.slice(0, 3)).toEqual(['/d', '/s', '/c']);
            expect(options).toEqual(expect.objectContaining({ windowsVerbatimArguments: true }));
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

describe('escapeWindowsCmdArgument', () => {
    it('quotes and double caret-escapes cmd.exe metacharacters', () => {
        expect(escapeWindowsCmdArgument('plain')).toBe('^^^"plain^^^"');
        expect(escapeWindowsCmdArgument('a&b')).toBe('^^^"a^^^&b^^^"');
        expect(escapeWindowsCmdArgument('trail\\')).toBe('^^^"trail\\\\^^^"');
        expect(escapeWindowsCmdArgument('')).toBe('^^^"^^^"');
    });
});

// Real cmd.exe round trip of the exact launch runCli performs (cmd.exe with
// windowsCmdArgs and windowsVerbatimArguments; see the routing test above)
// through inert shims shaped like the Salesforce CLI installer's sf.cmd: an
// outer shim that calls an inner shim with %*, which runs node with %*.
// The environment is passed explicitly: Jest's per-file process.env copy does
// not reach child processes, and the real sf must never be found.
const windowsOnly = process.platform === 'win32' ? describe : describe.skip;
windowsOnly('Windows cmd.exe launch through batch shims', () => {
    let dir = '';
    let env: NodeJS.ProcessEnv = {};

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-core-cmd-'));
        fs.writeFileSync(path.join(dir, 'argv.js'), 'process.stdout.write("MWARGV" + JSON.stringify(process.argv.slice(2)));\n');
        fs.writeFileSync(path.join(dir, 'inner.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0argv.js" %*\r\n`);
        fs.writeFileSync(path.join(dir, 'sf.cmd'),
            '@echo off\r\nsetlocal enableextensions\r\nif exist "%~dp0inner.cmd" (\r\n  "%~dp0inner.cmd" %*\r\n) else (\r\n  echo missing inner\r\n)\r\n');
        // Only the fake directory and the system directory: no real sf on PATH.
        const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
        env = { SystemRoot: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: `${dir};${path.join(systemRoot, 'System32')}` };
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    function launch(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
        const result = cp.spawnSync('cmd.exe', windowsCmdArgs(args), { cwd: dir, env, windowsVerbatimArguments: true, encoding: 'utf8' });
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    const cases: string[] = [
        'plain', 'with space', 'a&b', 'a|b', 'a>b', 'a<b', 'x^y', '100%', '%PATH%', '!x!',
        '(paren)', 'semi;colon', 'comma,x', 'eq=x', "single'q", 'C:\\dir with space\\', 'trail\\',
        '', 'a&echo.MWINJECTED', 'a|echo.MWINJECTED', '--flag=a b', 'tab\tx',
        "SELECT Id FROM ApexClass WHERE Name LIKE '%x%' AND (A > 1 OR B < 2)",
    ];

    it('passes every argument to the program verbatim and runs nothing else', () => {
        expect(launch(cases)).toEqual({ exitCode: 0, stdout: `MWARGV${JSON.stringify(cases)}`, stderr: '' });
    });

    it('also round-trips each argument on its own', () => {
        for (const arg of cases) {
            expect(launch([arg])).toEqual({ exitCode: 0, stdout: `MWARGV${JSON.stringify([arg])}`, stderr: '' });
        }
    });

    it('refuses arguments with a double quote or line break before launching', async () => {
        for (const unsafe of ['q"&echo.MWINJECTED', '"quoted"', 'line\nbreak', 'cr\rx']) {
            await expect(runCli(['org', unsafe], dir)).rejects.toThrow('Refusing to run sf');
        }
    });
});

describe('runCli unsafe Windows arguments', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('rejects on Windows without spawning, and passes them through elsewhere', async () => {
        const proc = createMockProc();
        const spawnSpy = jest.spyOn(cp, 'spawn').mockImplementation((() => {
            setImmediate(() => proc.emit('close', 0));
            return proc as unknown as cp.ChildProcessWithoutNullStreams;
        }) as unknown as typeof cp.spawn);
        const run = runCli(['data', 'query', '--query', 'say "hi"'], 'C:/root');
        if (process.platform === 'win32') {
            await expect(run).rejects.toThrow('Refusing to run sf');
            expect(spawnSpy).not.toHaveBeenCalled();
        } else {
            await expect(run).resolves.toMatchObject({ exitCode: 0 });
        }
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
