import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface CliResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    startTime: string;
    args: string[];
}

export interface CliOptions {
    timeoutMs?: number;
}

// cmd.exe metacharacters. On Windows `sf` is the `sf.cmd` batch shim, so every
// argument passes through cmd.exe twice: once for the `cmd /c` line and once
// when the shim expands `%*`. Unescaped, a `&` or `|` in an argument ends the
// `sf` command and runs the rest as another command.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quotes one argument for the Windows argument parser, then caret-escapes the
 * cmd.exe metacharacters for both cmd.exe passes, so the argument reaches
 * `sf` verbatim. Module-internal; exported for tests only.
 */
export function escapeWindowsCmdArgument(arg: string): string {
    // Backslashes before a quote, and at the end (before the closing quote),
    // are doubled; the quote itself becomes \".
    const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
    return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/**
 * The cmd.exe argument list that runs the absolute `sfPath` with `args`
 * passed verbatim. /d skips AutoRun commands, /v:off keeps `!` literal, and
 * /s strips exactly the outer quotes.
 */
export function windowsCmdArgs(sfPath: string, args: string[]): string[] {
    return ['/d', '/v:off', '/s', '/c', `""${sfPath}" ${args.map(escapeWindowsCmdArgument).join(' ')}"`];
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
}

function isSameOrInside(candidate: string, directory: string): boolean {
    const child = candidate.toLowerCase();
    const parent = directory.toLowerCase();
    return child === parent || child.startsWith(parent.endsWith('\\') ? parent : `${parent}\\`);
}

/**
 * Fully qualified Windows path: `C:\...` or `\\server\share\...`. Node's
 * isAbsolute also accepts `\dir` and `/dir`, which are relative to the current
 * drive, so the directory a child searches could differ from the one checked.
 */
export function isFullyQualifiedWindowsPath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function realOrUndefined(target: string): string | undefined {
    try {
        return fs.realpathSync(target);
    } catch {
        return undefined;
    }
}

/**
 * The environment for the cmd.exe child. The sf.cmd shims may run bare
 * commands (for example a `node` fallback), so cmd.exe must never find an
 * executable in the working directory (the user's project):
 * NoDefaultCurrentDirectoryInExePath=1 stops the current-directory search, and
 * PATH keeps only fully qualified entries whose real location is verified and
 * not at or inside the working directory, lexically or by real path. The child
 * gets exactly the normalized paths that were checked. Module-internal;
 * exported for tests.
 */
export function windowsChildEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const project = path.win32.resolve(cwd);
    const projectReal = realOrUndefined(project) ?? project;
    const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'Path';
    const kept: string[] = [];
    for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
        const entry = raw.trim().replace(/^"(.*)"$/, '$1');
        if (entry === '' || !isFullyQualifiedWindowsPath(entry)) continue;
        const dir = path.win32.resolve(entry);
        if (isSameOrInside(dir, project) || isSameOrInside(dir, projectReal)) continue;
        const real = realOrUndefined(dir);
        if (real === undefined || isSameOrInside(real, project) || isSameOrInside(real, projectReal)) continue;
        if (!kept.some(existing => existing.toLowerCase() === dir.toLowerCase())) kept.push(dir);
    }
    const child: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(env)) {
        const lower = name.toLowerCase();
        if (lower === 'path' || lower === 'nodefaultcurrentdirectoryinexepath') continue;
        child[name] = value;
    }
    child[pathKey] = kept.join(';');
    child.NoDefaultCurrentDirectoryInExePath = '1';
    return child;
}

/**
 * The system cmd.exe by absolute path (%SystemRoot%\System32\cmd.exe). A bare
 * `cmd.exe` can be found in the working directory before PATH. Module-internal;
 * exported for tests only.
 */
export function resolveWindowsCmd(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const systemRoot = envValue(env, 'SystemRoot') ?? envValue(env, 'windir');
    if (!systemRoot || !isFullyQualifiedWindowsPath(systemRoot)) return undefined;
    const cmd = path.win32.join(path.win32.resolve(systemRoot), 'System32', 'cmd.exe');
    try {
        return fs.statSync(cmd).isFile() ? cmd : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The absolute `sf.cmd` that cmd.exe should run: the first one in an absolute
 * PATH directory whose real location is outside the real working directory
 * (the user's project). A bare `sf.cmd` would let cmd.exe pick one from the
 * working directory first; a link could make a PATH entry point back into it.
 * A candidate whose real path cannot be verified is skipped. Module-internal;
 * exported for tests only.
 */
export function resolveWindowsSf(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const project = path.win32.resolve(cwd);
    let projectReal: string;
    try {
        projectReal = fs.realpathSync(project);
    } catch {
        return undefined;
    }
    for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
        const entry = raw.trim().replace(/^"(.*)"$/, '$1');
        if (entry === '' || !isFullyQualifiedWindowsPath(entry)) continue;
        const dir = path.win32.resolve(entry);
        if (isSameOrInside(dir, project) || isSameOrInside(dir, projectReal)) continue;
        const candidate = path.win32.join(dir, 'sf.cmd');
        // `%` would be expanded inside the quoted command path.
        if (candidate.includes('%')) continue;
        let candidateReal: string;
        try {
            if (!fs.statSync(candidate).isFile()) continue;
            candidateReal = fs.realpathSync(candidate);
        } catch {
            continue; // Missing here, or its real location cannot be verified.
        }
        if (isSameOrInside(candidateReal, projectReal) || isSameOrInside(candidateReal, project)) continue;
        return candidate;
    }
    return undefined;
}

/**
 * Characters no escaping can carry through the Salesforce CLI installer's
 * nested sf.cmd shims: each shim re-parses `%*`, and an embedded double quote
 * flips cmd.exe's quote state there, exposing any following metacharacter.
 * A line break ends a cmd.exe command line.
 */
const WINDOWS_UNSAFE_ARG = /["\r\n]/;

export async function runCli(args: string[], cwd: string, options?: CliOptions): Promise<CliResult> {
    const startTime = new Date().toISOString();
    const windows = process.platform === 'win32';
    const unsafe = windows ? args.find(arg => WINDOWS_UNSAFE_ARG.test(arg)) : undefined;
    if (unsafe !== undefined) {
        throw new Error(`Refusing to run sf: an argument contains a double quote or line break, which cannot be passed safely through cmd.exe: ${JSON.stringify(unsafe)}`);
    }
    const cmdPath = windows ? resolveWindowsCmd() : undefined;
    if (windows && cmdPath === undefined) {
        throw new Error('Refusing to run sf: the system cmd.exe (%SystemRoot%\\System32\\cmd.exe) was not found.');
    }
    const sfPath = windows ? resolveWindowsSf(cwd) : undefined;
    if (windows && sfPath === undefined) {
        throw new Error('sf.cmd was not found in a PATH directory outside the project (is the Salesforce CLI installed?)');
    }
    return new Promise((resolve, reject) => {
        const proc = windows && cmdPath !== undefined && sfPath !== undefined
            ? cp.spawn(cmdPath, windowsCmdArgs(sfPath, args), { cwd, env: windowsChildEnv(cwd), shell: false, windowsVerbatimArguments: true })
            : cp.spawn('sf', args, { cwd, shell: false });
        let stdout = '', stderr = '', settled = false;
        const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => {
            if (settled) return;
            settled = true;
            proc.kill();
            reject(new Error(`sf timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        proc.stdout.on('data', (part: Buffer) => { stdout += part.toString(); });
        proc.stderr.on('data', (part: Buffer) => { stderr += part.toString(); });
        proc.on('close', code => { if (timer) clearTimeout(timer); if (!settled) { settled = true; resolve({ stdout, stderr, exitCode: code ?? 1, startTime, args }); } });
        proc.on('error', error => { if (timer) clearTimeout(timer); if (!settled) { settled = true; reject(new Error(`${error.message} (is the Salesforce CLI installed?)`)); } });
    });
}

export function parseCliJson<T>(stdout: string, args: string[]): T {
    const lastNlBrace = stdout.lastIndexOf('\n{');
    const jsonStart = lastNlBrace >= 0 ? lastNlBrace + 1 : stdout.indexOf('{');
    const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
    try {
        return JSON.parse(jsonText) as T;
    } catch {
        throw new Error(`sf returned non-JSON output for: sf ${args.join(' ')}`);
    }
}

export function cliErrorText(stderr: string, stdout: string, exitCode: number): string {
    const stderrMeaningful = stderr
        .split('\n')
        .filter(line => {
            const t = line.trim();
            if (!t) return false;
            if (/update.{0,15}available/i.test(t)) return false;
            if (/^Warning\b/i.test(t)) return false;
            return true;
        })
        .join('\n')
        .trim();
    if (stderrMeaningful) {
        return stderrMeaningful;
    }
    if (stdout.trim()) {
        const candidates = [stdout, stdout.slice(stdout.lastIndexOf('\n{') + 1)];
        for (const candidate of candidates) {
            try {
                const json = JSON.parse(candidate) as {
                    message?: string;
                    name?: string;
                    result?: { message?: string };
                };
                const msg = json.message ?? json.result?.message ?? json.name ?? '';
                if (msg) {
                    return msg;
                }
            } catch {
                // try next candidate
            }
        }
    }
    return stderr.trim() || `sf exited with code ${exitCode}`;
}
