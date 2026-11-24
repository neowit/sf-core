import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli, parseCliJson, cliErrorText, escapeWindowsCmdArgument, resolveWindowsSf, windowsCmdArgs } from './cli';
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

// A dummy sf.cmd first on this file's PATH, so the Windows resolver finds one.
// Spawn is mocked in every test that uses it: the dummy never runs.
const PATH_KEY = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
let dummyBin = '';
let savedPath: string | undefined;
beforeAll(() => {
    dummyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-core-bin-'));
    fs.writeFileSync(path.join(dummyBin, 'sf.cmd'), '@echo off\r\nexit /b 0\r\n');
});
afterAll(() => {
    fs.rmSync(dummyBin, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
beforeEach(() => {
    savedPath = process.env[PATH_KEY];
    process.env[PATH_KEY] = `${dummyBin}${path.delimiter}${savedPath ?? ''}`;
});
afterEach(() => {
    if (savedPath === undefined) delete process.env[PATH_KEY];
    else process.env[PATH_KEY] = savedPath;
});

function mockSpawn(onSpawn?: (proc: MockProc) => void): jest.SpyInstance {
    const proc = createMockProc();
    return jest.spyOn(cp, 'spawn').mockImplementation((() => {
        setImmediate(() => { if (onSpawn) onSpawn(proc); else proc.emit('close', 0); });
        return proc as unknown as cp.ChildProcessWithoutNullStreams;
    }) as unknown as typeof cp.spawn);
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
            expect(spawnArgs).toEqual(windowsCmdArgs(path.join(dummyBin, 'sf.cmd'), ['org', 'display', 'C:/path with spaces']));
            expect(spawnArgs.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c']);
            expect(spawnArgs[4].startsWith(`""${path.join(dummyBin, 'sf.cmd')}" `)).toBe(true);
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

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;

windowsOnly('resolveWindowsSf', () => {
    let base = '';
    beforeAll(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-core-resolve-'));
        for (const name of ['project', path.join('project', 'bin'), 'tools', 'empty']) fs.mkdirSync(path.join(base, name));
        for (const name of ['project', path.join('project', 'bin'), 'tools']) fs.writeFileSync(path.join(base, name, 'sf.cmd'), '@echo off\r\n');
    });
    afterAll(() => {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    it('skips relative entries and directories at or inside the working directory', () => {
        const project = path.join(base, 'project');
        const env = { PATH: ['.', 'project', project, path.join(project, 'bin'), `"${path.join(base, 'empty')}"`, path.join(base, 'tools')].join(';') };
        expect(resolveWindowsSf(project, env)).toBe(path.join(base, 'tools', 'sf.cmd'));
    });

    it('returns undefined when only the working directory has sf.cmd', () => {
        const project = path.join(base, 'project');
        expect(resolveWindowsSf(project, { Path: `${project};${path.join(base, 'empty')}` })).toBeUndefined();
    });

    it('makes runCli fail closed without spawning when sf.cmd cannot be resolved', async () => {
        const spawnSpy = mockSpawn();
        process.env[PATH_KEY] = path.join(base, 'empty');
        await expect(runCli(['org'], path.join(base, 'project'))).rejects.toThrow('sf.cmd was not found');
        expect(spawnSpy).not.toHaveBeenCalled();
        jest.restoreAllMocks();
    });
});

// Real cmd.exe round trip of the exact launch runCli performs (cmd.exe with
// windowsCmdArgs and windowsVerbatimArguments; see the routing test above)
// through inert shims shaped like the Salesforce CLI installer's sf.cmd: an
// outer shim that calls an inner shim with %*, which runs node with %*.
// The working directory holds a hostile sf.cmd that must never run, and the
// child environment is explicit: no real sf can be found.
windowsOnly('Windows cmd.exe launch through batch shims', () => {
    let dir = '';
    let work = '';
    let env: NodeJS.ProcessEnv = {};

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-core-cmd-'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-core-work-'));
        fs.writeFileSync(path.join(dir, 'argv.js'), 'process.stdout.write("MWARGV" + JSON.stringify(process.argv.slice(2)));\n');
        fs.writeFileSync(path.join(dir, 'inner.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0argv.js" %*\r\n`);
        fs.writeFileSync(path.join(dir, 'sf.cmd'),
            '@echo off\r\nsetlocal enableextensions\r\nif exist "%~dp0inner.cmd" (\r\n  "%~dp0inner.cmd" %*\r\n) else (\r\n  echo missing inner\r\n)\r\n');
        fs.writeFileSync(path.join(work, 'sf.cmd'), '@echo off\r\necho HIJACKED\r\n');
        const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
        env = {
            SystemRoot: systemRoot,
            ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
            PATHEXT: '.COM;.EXE;.BAT;.CMD',
            PATH: `${work};${dir};${path.join(systemRoot, 'System32')}`,
        };
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    function launch(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
        const sfPath = resolveWindowsSf(work, env);
        if (sfPath !== path.join(dir, 'sf.cmd')) throw new Error(`resolved ${String(sfPath)}, refusing to launch`);
        const result = cp.spawnSync('cmd.exe', windowsCmdArgs(sfPath, args), { cwd: work, env, windowsVerbatimArguments: true, encoding: 'utf8' });
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

    it('never runs a sf.cmd from the working directory', () => {
        expect(launch(['org']).stdout).toBe('MWARGV["org"]');
    });
});

describe('runCli unsafe Windows arguments', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it.each(['q"&echo.MWINJECTED', '"quoted"', 'say "hi"', 'line\nbreak', 'cr\rx'])(
        'rejects %j on Windows without spawning, and passes it through elsewhere',
        async unsafe => {
            const spawnSpy = mockSpawn();
            const run = runCli(['data', 'query', '--query', unsafe], 'C:/root');
            if (process.platform === 'win32') {
                await expect(run).rejects.toThrow('Refusing to run sf');
                expect(spawnSpy).not.toHaveBeenCalled();
            } else {
                await expect(run).resolves.toMatchObject({ exitCode: 0 });
            }
        }
    );
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
