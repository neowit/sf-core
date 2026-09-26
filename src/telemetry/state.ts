import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CLIENT_ID_FILE = 'client-id';

const RECOVERED_CLIENT_ID_FILE = 'client-id.recovered';

const CLIENT_ID_LOCK_FILE = 'client-id.lock';

function asValidClientId(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return UUID_V4_RE.test(trimmed) ? trimmed : null;
}

async function replaceCorruptClientId(
    stateDir: string
): Promise<string | null> {
    const recoveredPath = path.join(stateDir, RECOVERED_CLIENT_ID_FILE);
    const tmpPath = path.join(
        stateDir,
        RECOVERED_CLIENT_ID_FILE + '.tmp-' + String(process.pid) + '-' + randomUUID()
    );
    try {
        await fs.writeFile(tmpPath, randomUUID(), { encoding: 'utf8', flag: 'wx' });
        try {
            await fs.link(tmpPath, recoveredPath);
        } catch (err) {
            // An existing immutable winner is the only recoverable link error.
            // All other errors fail closed without touching either ID file.
            // The error code is checked here rather than attempting replacement.
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                return null;
            }
        }
        return asValidClientId(await fs.readFile(recoveredPath, 'utf8'));
    } catch {
        return null;
    } finally {
        try {
            await fs.rm(tmpPath, { force: true });
        } catch {
            // Best-effort cleanup; never remove the immutable winner.
        }
    }
}

export async function loadOrCreateClientId(stateDir: string): Promise<string | null> {
    try {
        await fs.mkdir(stateDir, { recursive: true });
    } catch {
        return null;
    }
    const filePath = path.join(stateDir, CLIENT_ID_FILE);
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const valid = asValidClientId(raw);
        if (valid !== null) {
            return valid;
        }
        return await replaceCorruptClientId(stateDir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            return null;
        }
    }
    const fresh = randomUUID();
    try {
        await fs.writeFile(filePath, fresh, { encoding: 'utf8', flag: 'wx' });
        return fresh;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            return null;
        }
        try {
            const winnerRaw = await fs.readFile(filePath, 'utf8');
            const winner = asValidClientId(winnerRaw);
            if (winner !== null) {
                return winner;
            }
            return await replaceCorruptClientId(stateDir);
        } catch {
            return null;
        }
    }
}

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
            return false;
        }
        return true;
    }
}

export async function purgeTelemetryState(stateDir: string): Promise<void> {
    try {
        await fs.rm(path.join(stateDir, CLIENT_ID_FILE), { force: true });
    } catch {
        // never throws
    }
    try {
        await fs.rm(path.join(stateDir, RECOVERED_CLIENT_ID_FILE), { force: true });
    } catch {
        // never throws
    }
    try {
        // Remove the legacy lock file when telemetry state is purged.
        await fs.rm(path.join(stateDir, CLIENT_ID_LOCK_FILE), { force: true });
    } catch {
        // never throws
    }
    try {
        await fs.rm(path.join(stateDir, 'telemetry'), { recursive: true, force: true });
    } catch {
        // never throws
    }
}
