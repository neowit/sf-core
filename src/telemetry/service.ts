import { randomUUID } from 'crypto';
import { ActionCounts, TelemetryBatch, isTelemetryAction, toTelemetryBatch } from './types';
import { loadOrCreateClientId, purgeTelemetryState } from './state';
import { createTelemetryStore, TelemetryStore } from './store';
import { sendTelemetryBatch } from './transport';
import type { TelemetryRequestLogger } from './transport';

const FIRST_DELAY_MS = 30000;
const INTERVAL_MS = 600000;
const MAX_BACKOFF_MS = 21600000;
const MAX_BUFFERED_ACTION_COUNT = 1000;

export type TelemetryServiceSender<Action extends string> = (
    batch: TelemetryBatch<Action>,
) => Promise<'acked' | 'retry'>;

export type TelemetryServiceOptions<Action extends string> = {
    enabled: boolean;
    stateDir: string;
    appVersion: string;
    os: string;
    actions: readonly Action[];
    endpoint: string;
    payloadHeader: string;
    firstDelayMs?: number;
    intervalMs?: number;
    sender?: TelemetryServiceSender<Action>;
    requestLogger?: TelemetryRequestLogger;
};

export type TelemetryService = {
    record(action: unknown): void;
    start(): Promise<void>;
    shutdown(): Promise<void>;
};

export function createTelemetryService<Action extends string>(
    opts: TelemetryServiceOptions<Action>,
): TelemetryService {
    const firstDelay = opts.firstDelayMs ?? FIRST_DELAY_MS;
    const interval = opts.intervalMs ?? INTERVAL_MS;
    const sender: TelemetryServiceSender<Action> =
        opts.sender ??
        ((batch) =>
            sendTelemetryBatch(batch, {
                endpoint: opts.endpoint,
                payloadHeader: opts.payloadHeader,
                requestLogger: opts.requestLogger,
            }));
    const sessionId = randomUUID();

    let shut = false;
    let selfDisabled = false;
    let started = false;
    let startPromise: Promise<void> | null = null;
    let store: TelemetryStore<Action> | null = null;
    let timer: NodeJS.Timeout | null = null;
    let failures = 0;
    let buffered: ActionCounts<Action> = {};

    function schedule(delayMs: number): void {
        try {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            if (shut || selfDisabled || !opts.enabled) {
                return;
            }
            timer = setTimeout(() => {
                timer = null;
                void runCycle();
            }, delayMs);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        } catch {
            // never throws
        }
    }

    function backoffDelay(): number {
        try {
            const grown = interval * Math.pow(2, failures);
            const capped = Math.min(grown, MAX_BACKOFF_MS);
            const jittered = capped * (0.8 + 0.4 * Math.random());
            return Math.max(1, Math.min(Math.floor(jittered), MAX_BACKOFF_MS));
        } catch {
            return interval;
        }
    }

    async function runCycle(): Promise<void> {
        if (shut || selfDisabled || !opts.enabled || store === null) {
            return;
        }
        const active = store;
        try {
            try {
                await active.sealCurrentBatch();
            } catch {
                // seal failure keeps memory and draft for retry
            }
            let pending;
            try {
                pending = await active.listPendingBatches();
            } catch {
                schedule(interval);
                return;
            }
            if (pending.length === 0) {
                failures = 0;
                schedule(interval);
                return;
            }
            let sawRetry = false;
            async function deleteInvalidPendingBatch(raw: unknown): Promise<void> {
                try {
                    if (typeof raw !== 'object' || raw === null) {
                        return;
                    }
                    const batchId = (raw as { batchId?: unknown }).batchId;
                    if (typeof batchId === 'string') {
                        await active.deletePendingBatch(batchId);
                    }
                } catch {
                    // invalid pending cleanup is best-effort; never throws
                }
            }
            for (const raw of pending) {
                if (shut) {
                    break;
                }
                let clean;
                try {
                    clean = toTelemetryBatch(raw, opts.actions);
                } catch {
                    await deleteInvalidPendingBatch(raw);
                    continue;
                }
                if (clean === null) {
                    await deleteInvalidPendingBatch(raw);
                    continue;
                }
                let outcome: 'acked' | 'retry' = 'retry';
                try {
                    outcome = await sender(clean);
                } catch {
                    outcome = 'retry';
                }
                if (outcome === 'acked') {
                    try {
                        await active.deletePendingBatch(clean.batchId);
                    } catch {
                        // retain on failure; never throws
                    }
                } else {
                    sawRetry = true;
                }
            }
            if (sawRetry) {
                failures += 1;
                schedule(backoffDelay());
            } else {
                failures = 0;
                schedule(interval);
            }
        } catch {
            try {
                schedule(interval);
            } catch {
                // never throws
            }
        }
    }

    function record(action: unknown): void {
        try {
            if (!isTelemetryAction(action, opts.actions)) {
                return;
            }
            if (!opts.enabled || selfDisabled || shut) {
                return;
            }
            if (store !== null && started) {
                try {
                    store.add(action);
                } catch {
                    // never throws
                }
                return;
            }
            const key = action;
            // ponytail: cap each action at 1000, bounding pre-start buffering.
            buffered[key] = Math.min(MAX_BUFFERED_ACTION_COUNT, (buffered[key] ?? 0) + 1);
        } catch {
            // never throws
        }
    }

    async function init(): Promise<void> {
        if (!opts.enabled) {
            try {
                await purgeTelemetryState(opts.stateDir);
            } catch {
                // never throws
            }
            return;
        }
        let clientId: string | null = null;
        try {
            clientId = await loadOrCreateClientId(opts.stateDir);
        } catch {
            clientId = null;
        }
        if (clientId === null) {
            selfDisabled = true;
            return;
        }
        try {
            const created = createTelemetryStore({
                stateDir: opts.stateDir,
                sessionId,
                clientId,
                os: opts.os,
                appVersion: opts.appVersion,
                actions: opts.actions,
            });
            try {
                await created.recoverOrphanedDrafts();
            } catch {
                // recovery failure is non-fatal; continue with fresh store
            }
            store = created;
            started = true;
            const pending = buffered;
            buffered = {};
            for (const [key, count] of Object.entries(pending)) {
                try {
                    if (!isTelemetryAction(key, opts.actions)) {
                        continue;
                    }
                    const n = count as number;
                    if (!shut) {
                        created.addMany(key, n);
                    }
                } catch {
                    // per-action fail closed; never throws
                }
            }
            if (!shut) {
                schedule(firstDelay);
            }
        } catch {
            store = null;
            selfDisabled = true;
        }
    }

    async function start(): Promise<void> {
        try {
            if (startPromise !== null) {
                await startPromise;
                return;
            }
            startPromise = init();
            await startPromise;
        } catch {
            // never throws; self-disable on unexpected failure
            selfDisabled = true;
        }
    }

    async function shutdown(): Promise<void> {
        try {
            shut = true;
            if (timer !== null) {
                try {
                    clearTimeout(timer);
                } catch {
                    // ignore
                }
                timer = null;
            }
            if (startPromise !== null) {
                try {
                    await startPromise;
                } catch {
                    // startup never blocks shutdown
                }
            }
            if (timer !== null) {
                try {
                    clearTimeout(timer);
                } catch {
                    // ignore
                }
                timer = null;
            }
            if (store !== null) {
                const active = store;
                store = null;
                try {
                    await active.shutdown();
                } catch {
                    // never throws
                }
            }
        } catch {
            // never throws
        }
    }

    return { record, start, shutdown };
}
