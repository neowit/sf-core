import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    ActionCounts,
    TelemetryBatch,
    isTelemetryAction,
    toTelemetryBatch,
} from './types';
import { isProcessAlive as defaultIsProcessAlive } from './state';

const DRAFT_PREFIX = 'draft-';
const JSON_SUFFIX = '.json';
const CORRUPT_SUFFIX = '.corrupt';
const DEFAULT_DEBOUNCE_MS = 1000;
const SAFE_BATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TelemetryStoreOptions<Action extends string> = {
    stateDir: string;
    sessionId: string;
    clientId: string;
    os: string;
    appVersion: string;
    actions: readonly Action[];
    pid?: number;
    debounceMs?: number;
    isProcessAlive?: (pid: number) => boolean;
};

export type TelemetryStore<Action extends string> = {
    add(action: Action): void;
    addMany(action: Action, count: number): void;
    snapshot(): ActionCounts<Action>;
    flushDraft(): Promise<void>;
    sealCurrentBatch(): Promise<TelemetryBatch<Action> | null>;
    recoverOrphanedDrafts(): Promise<void>;
    listPendingBatches(): Promise<TelemetryBatch<Action>[]>;
    deletePendingBatch(batchId: string): Promise<void>;
    shutdown(): Promise<void>;
};

export function createTelemetryStore<Action extends string>(
    opts: TelemetryStoreOptions<Action>,
): TelemetryStore<Action> {
    const ownerPid = opts.pid ?? process.pid;
    const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const probe = opts.isProcessAlive ?? defaultIsProcessAlive;
    const actions = opts.actions;
    const telemetryDir = path.join(opts.stateDir, 'telemetry');
    const draftsDir = path.join(telemetryDir, 'drafts');
    const sessionsDir = path.join(telemetryDir, 'sessions');
    const pendingDir = path.join(telemetryDir, 'pending');
    const draftFile = path.join(draftsDir, DRAFT_PREFIX + opts.sessionId + JSON_SUFFIX);
    const markerFile = path.join(sessionsDir, opts.sessionId + JSON_SUFFIX);

    let counts: ActionCounts<Action> = {};
    let batchId = randomUUID();
    let lastPersisted: TelemetryBatch<Action> | null = null;
    let dirty = false;
    let markerEnsured = false;
    let timer: NodeJS.Timeout | null = null;
    let writeChain: Promise<void> = Promise.resolve();

    function snapshot(): ActionCounts<Action> {
        return { ...counts };
    }

    function addMany(action: Action, count: number): void {
        if (!isTelemetryAction(action, actions) || !Number.isSafeInteger(count) || count <= 0) {
            return;
        }
        counts[action] = (counts[action] ?? 0) + count;
        dirty = true;
        if (timer === null) {
            timer = setTimeout(() => {
                timer = null;
                void scheduleDraftWrite();
            }, debounceMs);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        }
    }

    function add(action: Action): void {
        addMany(action, 1);
    }

    function scheduleDraftWrite(): Promise<void> {
        writeChain = writeChain.then(writeDraftOnce);
        return writeChain;
    }

    async function writeDraftOnce(): Promise<void> {
        if (!dirty) {
            return;
        }
        dirty = false;
        if (!(await persistDraft())) {
            dirty = true;
        }
    }

    async function persistDraft(): Promise<boolean> {
        let tmp: string | null = null;
        try {
            await fs.mkdir(sessionsDir, { recursive: true });
            await fs.mkdir(draftsDir, { recursive: true });
            if (!markerEnsured) {
                await fs.writeFile(markerFile, JSON.stringify({ pid: ownerPid }), 'utf8');
                markerEnsured = true;
            }
            const batch: TelemetryBatch<Action> = {
                schemaVersion: 1,
                batchId,
                clientId: opts.clientId,
                os: opts.os,
                appVersion: opts.appVersion,
                actionCounts: { ...counts },
            };
            tmp = path.join(
                draftsDir,
                DRAFT_PREFIX + opts.sessionId + '.tmp-' + String(process.pid) + '-' + randomUUID()
            );
            await fs.writeFile(tmp, JSON.stringify(batch), { encoding: 'utf8', flag: 'wx' });
            await fs.rename(tmp, draftFile);
            tmp = null;
            lastPersisted = batch;
            return true;
        } catch {
            if (tmp !== null) {
                try {
                    await fs.rm(tmp, { force: true });
                } catch {
                    // ignore cleanup failure
                }
            }
            return false;
        }
    }

    async function flushDraft(): Promise<void> {
        try {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            await scheduleDraftWrite();
            if (dirty) {
                await scheduleDraftWrite();
            }
        } catch {
            // never throws; failed writes keep dirty set for retry
        }
    }

    async function sealCurrentBatch(): Promise<TelemetryBatch<Action> | null> {
        try {
            await flushDraft();
            if (dirty || Object.keys(counts).length === 0 || lastPersisted === null) {
                return null;
            }
            // The sealed payload is the already-persisted draft snapshot,
            // not live memory: an add() landing on any await below must
            // neither be erased nor smuggled into a batch the draft file
            // omits. Only this process writes its own draft, so the snapshot
            // taken at persist time is exactly what the rename below moves.
            const sealed: TelemetryBatch<Action> = {
                ...lastPersisted,
                actionCounts: { ...lastPersisted.actionCounts },
            };
            await fs.mkdir(pendingDir, { recursive: true });
            try {
                await fs.rename(draftFile, path.join(pendingDir, sealed.batchId + JSON_SUFFIX));
            } catch {
                return null;
            }
            // Subtract exactly what was sealed; anything added meanwhile is
            // retained under the fresh batch ID and stays dirty for retry.
            for (const [action, sealedCount] of Object.entries(sealed.actionCounts)) {
                const key = action as Action;
                const current = counts[key] ?? 0;
                if (current <= (sealedCount as number)) {
                    delete counts[key];
                } else {
                    counts[key] = current - (sealedCount as number);
                }
            }
            if (Object.keys(counts).length > 0) {
                dirty = true;
            }
            batchId = randomUUID();
            lastPersisted = null;
            return sealed;
        } catch {
            return null;
        }
    }

    async function claimDraft(name: string): Promise<void> {
        const draftPath = path.join(draftsDir, name);
        let raw: string;
        try {
            raw = await fs.readFile(draftPath, 'utf8');
        } catch {
            return;
        }
        let batch: TelemetryBatch<Action> | null = null;
        try {
            batch = toTelemetryBatch(JSON.parse(raw), actions);
        } catch {
            batch = null;
        }
        if (batch === null) {
            try {
                await fs.rename(draftPath, draftPath + CORRUPT_SUFFIX);
            } catch {
                // fail closed
            }
            return;
        }
        const pendingFile = path.join(pendingDir, batch.batchId + JSON_SUFFIX);
        try {
            let existing: string | null = null;
            try {
                existing = await fs.readFile(pendingFile, 'utf8');
            } catch {
                existing = null;
            }
            if (existing !== null) {
                if (existing === raw) {
                    try {
                        await fs.unlink(draftPath);
                    } catch {
                        // fail closed
                    }
                }
                return;
            }
            await fs.mkdir(pendingDir, { recursive: true });
            await fs.rename(draftPath, pendingFile);
        } catch {
            // fail closed
        }
    }

    async function recoverOrphanedDrafts(): Promise<void> {
        try {
            let names: string[];
            try {
                names = await fs.readdir(draftsDir);
            } catch {
                return;
            }
            for (const name of names) {
                if (!name.startsWith(DRAFT_PREFIX) || !name.endsWith(JSON_SUFFIX)) {
                    continue;
                }
                const draftSessionId = name.slice(DRAFT_PREFIX.length, -JSON_SUFFIX.length);
                if (!draftSessionId) {
                    continue;
                }
                try {
                    let markerMissing = false;
                    let owner: number | null = null;
                    let uncertain = false;
                    try {
                        const markerRaw = await fs.readFile(
                            path.join(sessionsDir, draftSessionId + JSON_SUFFIX),
                            'utf8'
                        );
                        try {
                            const parsed = JSON.parse(markerRaw) as { pid?: unknown };
                            if (
                                parsed &&
                                typeof parsed.pid === 'number' &&
                                Number.isSafeInteger(parsed.pid)
                            ) {
                                owner = parsed.pid;
                            } else {
                                uncertain = true;
                            }
                        } catch {
                            uncertain = true;
                        }
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                            markerMissing = true;
                        } else {
                            uncertain = true;
                        }
                    }
                    if (uncertain) {
                        continue;
                    }
                    if (!markerMissing) {
                        let alive = true;
                        try {
                            alive = probe(owner as number);
                        } catch {
                            continue;
                        }
                        if (alive) {
                            continue;
                        }
                    }
                    // ponytail: OS PID reuse can delay recovery until the
                    // reused PID exits; delayed, never duplicated or dropped.
                    await claimDraft(name);
                } catch {
                    // per-file fail closed; continue with the next draft
                }
            }
        } catch {
            // never throws
        }
    }

    async function listPendingBatches(): Promise<TelemetryBatch<Action>[]> {
        const out: TelemetryBatch<Action>[] = [];
        try {
            let names: string[];
            try {
                names = await fs.readdir(pendingDir);
            } catch {
                return out;
            }
            for (const name of names) {
                if (!name.endsWith(JSON_SUFFIX)) {
                    continue;
                }
                const filePath = path.join(pendingDir, name);
                let raw: string;
                try {
                    raw = await fs.readFile(filePath, 'utf8');
                } catch {
                    continue;
                }
                let batch: TelemetryBatch<Action> | null = null;
                try {
                    batch = toTelemetryBatch(JSON.parse(raw), actions);
                } catch {
                    batch = null;
                }
                // The store invariant is pending/<batchId>.json, matching
                // what deletePendingBatch removes after ack. A valid payload
                // under any other name would be resent forever, so treat the
                // mismatch as corrupt persisted state and quarantine it.
                if (batch !== null && name !== batch.batchId + JSON_SUFFIX) {
                    batch = null;
                }
                if (batch === null) {
                    try {
                        await fs.rename(filePath, filePath + CORRUPT_SUFFIX);
                    } catch {
                        // fail closed
                    }
                    continue;
                }
                out.push(batch);
            }
        } catch {
            // never throws
        }
        return out;
    }

    async function deletePendingBatch(batchIdValue: string): Promise<void> {
        try {
            if (typeof batchIdValue !== 'string' || !SAFE_BATCH_ID_RE.test(batchIdValue)) {
                return;
            }
            await fs.unlink(path.join(pendingDir, batchIdValue + JSON_SUFFIX));
        } catch {
            // never throws
        }
    }

    async function shutdown(): Promise<void> {
        try {
            await flushDraft();
            try {
                await fs.unlink(markerFile);
            } catch {
                // never throws
            }
        } catch {
            // never throws
        }
    }

    return {
        add,
        addMany,
        snapshot,
        flushDraft,
        sealCurrentBatch,
        recoverOrphanedDrafts,
        listPendingBatches,
        deletePendingBatch,
        shutdown,
    };
}
