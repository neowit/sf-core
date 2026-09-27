import * as cp from 'child_process';

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

export async function runCli(args: string[], cwd: string, options?: CliOptions): Promise<CliResult> {
    const startTime = new Date().toISOString();
    return new Promise((resolve, reject) => {
        const windows = process.platform === 'win32';
        const proc = cp.spawn(windows ? 'cmd.exe' : 'sf', windows ? ['/c', 'sf.cmd', ...args] : args, { cwd, shell: false });
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
