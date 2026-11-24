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

function pathValue(env: NodeJS.ProcessEnv): string {
    const key = Object.keys(env).find(name => name.toLowerCase() === 'path');
    return (key === undefined ? undefined : env[key]) ?? '';
}

/**
 * The absolute `sf.cmd` that cmd.exe should run: the first one in an absolute
 * PATH directory outside `cwd`. A bare `sf.cmd` would let cmd.exe pick one
 * from the working directory (the user's project) first. Module-internal;
 * exported for tests only.
 */
export function resolveWindowsSf(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const project = path.win32.resolve(cwd).toLowerCase();
    const projectPrefix = project.endsWith('\\') ? project : `${project}\\`;
    for (const raw of pathValue(env).split(';')) {
        const entry = raw.trim().replace(/^"(.*)"$/, '$1');
        if (entry === '' || !path.win32.isAbsolute(entry)) continue;
        const dir = path.win32.resolve(entry);
        const key = dir.toLowerCase();
        if (key === project || key.startsWith(projectPrefix)) continue;
        const candidate = path.win32.join(dir, 'sf.cmd');
        // `%` would be expanded inside the quoted command path.
        if (candidate.includes('%')) continue;
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            // Not in this directory.
        }
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
    const sfPath = windows ? resolveWindowsSf(cwd) : undefined;
    if (windows && sfPath === undefined) {
        throw new Error('sf.cmd was not found in a PATH directory outside the project (is the Salesforce CLI installed?)');
    }
    return new Promise((resolve, reject) => {
        const proc = windows && sfPath !== undefined
            ? cp.spawn('cmd.exe', windowsCmdArgs(sfPath, args), { cwd, shell: false, windowsVerbatimArguments: true })
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
