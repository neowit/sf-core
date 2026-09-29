import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as telemetryStore from './store';
import * as telemetryTypes from './types';
import * as transport from './transport';
import { createTelemetryService, type TelemetryServiceOptions } from './service';
import type { TelemetryBatch } from './types';
import type { TelemetryStore } from './store';

const ACTIONS = ['compile', 'navigate'] as const;
type TestAction = (typeof ACTIONS)[number];
const READY_FIELD = 'apexsense-ready-in-sec';
const OTHER_NUMERIC_FIELD = 'apexsense-startup-marker';

const ENDPOINT = 'https://usage.invalid/collect';
const PAYLOAD_HEADER = 'X-Client-Payload-Version';

const VALID_BATCH_ID = '123e4567-e89b-42d3-a456-426614174000';
const VALID_CLIENT_ID = '123e4567-e89b-42d3-a456-426614174001';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-service-test-'));
}

function pendingDir(stateDir: string): string {
    return path.join(stateDir, 'telemetry', 'pending');
}

function baseOptions(
    overrides: Partial<TelemetryServiceOptions<TestAction>> & Pick<TelemetryServiceOptions<TestAction>, 'stateDir'>,
): TelemetryServiceOptions<TestAction> {
    return {
        enabled: true,
        appVersion: '1.2.3',
        os: 'linux',
        actions: ACTIONS,
        endpoint: ENDPOINT,
        payloadHeader: PAYLOAD_HEADER,
        firstDelayMs: 30000,
        intervalMs: 600000,
        ...overrides,
    };
}

afterEach(async () => {
    jest.useRealTimers();
});

// The service timer fires runCycle() fire-and-forget and the cycle does real
// fs I/O, so after advancing fake time yield to the real event loop until the
// in-flight cycle lands.
const { setTimeout: realSetTimeout } = jest.requireActual('timers') as typeof import('timers');

async function advance(ms: number): Promise<void> {
    await jest.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 50; i++) {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
    }
}

describe('telemetryService', () => {

    test('buffers pre-start record and sends aggregated counts at first delayed cycle', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(baseOptions({ stateDir, sender }));
        expect(() => svc.record('compile')).not.toThrow();
        const starting = svc.start();
        expect(() => svc.record('compile')).not.toThrow();
        await starting;
        expect(sender).not.toHaveBeenCalled();
        expect(() => svc.record('compile')).not.toThrow();
        expect(() => svc.record('bogus')).not.toThrow();
        expect(sender).not.toHaveBeenCalled();
        await advance(30000);
        expect(sender).toHaveBeenCalledTimes(1);
        const batch = sender.mock.calls[0][0];
        expect(batch.actionCounts).toEqual({ compile: 3 });
        expect(batch.schemaVersion).toBe(1);
        await svc.shutdown();
    });

    test('buffers numeric fields before, during, and after start and sends them with actions', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, sender, numericFields: [READY_FIELD, OTHER_NUMERIC_FIELD] }),
        );

        svc.recordNumericField(READY_FIELD, 7);
        const starting = svc.start();
        svc.recordNumericField(OTHER_NUMERIC_FIELD, 11);
        svc.record('compile');
        await starting;
        svc.recordNumericField(READY_FIELD, 13);
        await advance(30000);

        expect(sender).toHaveBeenCalledTimes(1);
        expect(sender.mock.calls[0][0]).toMatchObject({
            actionCounts: { compile: 1 },
            [READY_FIELD]: 13,
            [OTHER_NUMERIC_FIELD]: 11,
        });
        await svc.shutdown();
    });

    test('deletes a metric-only batch after one send attempt', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('retry');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, sender, numericFields: [READY_FIELD], firstDelayMs: 1000, intervalMs: 1000 }),
        );

        await svc.start();
        svc.recordNumericField(READY_FIELD, 11);
        await advance(1000);
        expect(sender).toHaveBeenCalledTimes(1);
        const first = sender.mock.calls[0][0];
        expect(first.actionCounts).toEqual({});
        expect(first[READY_FIELD]).toBe(11);
        expect(fs.existsSync(path.join(pendingDir(stateDir), first.batchId + '.json'))).toBe(false);
        await advance(1000);
        expect(sender).toHaveBeenCalledTimes(1);

        await advance(60000);
        expect(sender).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(path.join(pendingDir(stateDir), first.batchId + '.json'))).toBe(false);
        await svc.shutdown();
    });

    test('recovers a metric-only draft once after shutdown and restart', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const first = createTelemetryService<TestAction>(
            baseOptions({ stateDir, numericFields: [READY_FIELD], firstDelayMs: 60000 }),
        );
        await first.start();
        first.recordNumericField(READY_FIELD, 11);
        await first.shutdown();

        const sender = jest.fn().mockResolvedValue('acked');
        const restarted = createTelemetryService<TestAction>(
            baseOptions({ stateDir, numericFields: [READY_FIELD], firstDelayMs: 1000, sender }),
        );
        await restarted.start();
        await advance(1000);
        expect(sender).toHaveBeenCalledTimes(1);
        expect(sender.mock.calls[0][0].actionCounts).toEqual({});
        expect(sender.mock.calls[0][0][READY_FIELD]).toBe(11);
        await advance(1000);
        expect(sender).toHaveBeenCalledTimes(1);
        await restarted.shutdown();
    });

    test('ignores invalid and reserved numeric fields, and disabled telemetry never records or sends', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ enabled: false, stateDir, sender, numericFields: [READY_FIELD] }),
        );
        for (const [field, value] of [
            [READY_FIELD, -1],
            [READY_FIELD, 1.5],
            [READY_FIELD, Number.MAX_SAFE_INTEGER + 1],
            ['unknown-field', 11],
            ['clientId', 8],
            [undefined, 11],
        ] as const) {
            expect(() => svc.recordNumericField(field, value)).not.toThrow();
        }
        expect(() => svc.recordNumericField(READY_FIELD, 11)).not.toThrow();
        await svc.start();
        await advance(3600000);
        expect(sender).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(stateDir, 'client-id'))).toBe(false);
        await svc.shutdown();
        expect(() => svc.recordNumericField(READY_FIELD, 11)).not.toThrow();

        const failedStateDir = path.join(stateDir, 'not-a-dir');
        fs.writeFileSync(failedStateDir, 'x');
        const selfDisabled = createTelemetryService<TestAction>(
            baseOptions({ stateDir: failedStateDir, sender, numericFields: [READY_FIELD] }),
        );
        await selfDisabled.start();
        expect(() => selfDisabled.recordNumericField(READY_FIELD, 11)).not.toThrow();
        await advance(3600000);
        expect(sender).not.toHaveBeenCalled();
        await selfDisabled.shutdown();
    });

    test('saturates pre-start counts at 1000 and sends the bounded aggregate', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(baseOptions({ stateDir, sender }));
        for (let i = 0; i < 1002; i++) {
            svc.record('compile');
        }
        await svc.start();
        await advance(30000);
        expect(sender).toHaveBeenCalledTimes(1);
        expect(sender.mock.calls[0][0].actionCounts).toEqual({ compile: 1000 });
        await svc.shutdown();
    });

    test('replays pre-start counts with one bulk store call per action', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const createStore = telemetryStore.createTelemetryStore;
        const storeSpies: { add?: jest.SpyInstance; addMany?: jest.SpyInstance } = {};
        const createStoreSpy = jest
            .spyOn(telemetryStore, 'createTelemetryStore')
            .mockImplementation((options) => {
                const store = createStore(options);
                storeSpies.add = jest.spyOn(store, 'add');
                storeSpies.addMany = jest.spyOn(store, 'addMany');
                return store;
            });
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, sender: jest.fn().mockResolvedValue('acked') }),
        );

        try {
            svc.record('compile');
            svc.record('compile');
            svc.record('compile');
            svc.record('navigate');
            svc.record('navigate');
            await svc.start();

            expect(storeSpies.addMany).toHaveBeenCalledTimes(2);
            expect(storeSpies.addMany).toHaveBeenNthCalledWith(1, 'compile', 3);
            expect(storeSpies.addMany).toHaveBeenNthCalledWith(2, 'navigate', 2);
            expect(storeSpies.add).not.toHaveBeenCalled();
        } finally {
            await svc.shutdown();
            storeSpies.add?.mockRestore();
            storeSpies.addMany?.mockRestore();
            createStoreSpy.mockRestore();
        }
    });

    test('disabled start purges only telemetry state and schedules nothing', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        fs.writeFileSync(path.join(stateDir, 'client-id'), VALID_CLIENT_ID);
        fs.mkdirSync(path.join(stateDir, 'telemetry', 'drafts'), { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'telemetry', 'drafts', 'x.json'), '{}');
        fs.writeFileSync(path.join(stateDir, 'other.json'), '{"a":1}');
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ enabled: false, stateDir, sender }),
        );
        await svc.start();
        expect(fs.existsSync(path.join(stateDir, 'client-id'))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, 'telemetry'))).toBe(false);
        expect(fs.readFileSync(path.join(stateDir, 'other.json'), 'utf8')).toBe('{"a":1}');
        await advance(3600000);
        expect(sender).not.toHaveBeenCalled();
        await svc.shutdown();
    });

    test('deletes an attempted batch when the sender reports retry and does not resend it', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('retry');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, firstDelayMs: 1000, intervalMs: 1000, sender }),
        );
        await svc.start();
        svc.record('compile');
        await advance(1000);
        expect(sender).toHaveBeenCalledTimes(1);
        const sentBatchId = sender.mock.calls[0][0].batchId as string;
        const pendingFile = path.join(pendingDir(stateDir), sentBatchId + '.json');
        expect(fs.existsSync(pendingFile)).toBe(false);
        await advance(1000);
        expect(sender).toHaveBeenCalledTimes(1);
        await advance(60000);
        expect(sender).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(pendingFile)).toBe(false);
        await svc.shutdown();
    });

    test('deletes a pending batch that fails defensive validation without retrying it', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const batch: TelemetryBatch<TestAction> = {
            schemaVersion: 1 as const,
            batchId: VALID_BATCH_ID,
            clientId: VALID_CLIENT_ID,
            os: 'linux',
            appVersion: '1.2.3',
            actionCounts: { compile: 1 },
        };
        let pending: TelemetryBatch<TestAction>[] = [batch];
        const store: TelemetryStore<TestAction> = {
            add: jest.fn(),
            addMany: jest.fn(),
            addNumericField: jest.fn(),
            snapshot: jest.fn().mockReturnValue({}),
            flushDraft: jest.fn().mockResolvedValue(undefined),
            sealCurrentBatch: jest.fn().mockResolvedValue(null),
            recoverOrphanedDrafts: jest.fn().mockResolvedValue(undefined),
            listPendingBatches: jest.fn().mockImplementation(() => Promise.resolve(pending)),
            deletePendingBatch: jest.fn().mockImplementation((batchId: string) => {
                pending = pending.filter((candidate) => candidate.batchId !== batchId);
                return Promise.resolve();
            }),
            shutdown: jest.fn().mockResolvedValue(undefined),
        };
        const createStoreSpy = jest
            .spyOn(telemetryStore, 'createTelemetryStore')
            .mockReturnValue(store);
        const validationSpy = jest.spyOn(telemetryTypes, 'toTelemetryBatch').mockReturnValue(null);
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, firstDelayMs: 1000, intervalMs: 1000, sender }),
        );

        try {
            await svc.start();
            await advance(1000);
            expect(sender).not.toHaveBeenCalled();
            expect(store.deletePendingBatch).toHaveBeenCalledWith(VALID_BATCH_ID);
            await advance(1000);
            expect(store.listPendingBatches).toHaveBeenCalledTimes(2);
            expect(sender).not.toHaveBeenCalled();
        } finally {
            await svc.shutdown();
            validationSpy.mockRestore();
            createStoreSpy.mockRestore();
        }
    });

    test('sender failures delete attempted batches and never escape record', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockImplementation(() => {
            throw new Error('boom');
        });
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, firstDelayMs: 1000, intervalMs: 1000, sender }),
        );
        expect(() => svc.record('compile')).not.toThrow();
        await expect(svc.start()).resolves.toBeUndefined();
        expect(() => svc.record('compile')).not.toThrow();
        expect(() => svc.record(undefined)).not.toThrow();
        await advance(2000);
        expect(sender).toHaveBeenCalledTimes(1);
        const attemptedBatchId = sender.mock.calls[0][0].batchId as string;
        expect(fs.existsSync(path.join(pendingDir(stateDir), attemptedBatchId + '.json'))).toBe(false);
        expect(() => svc.record('navigate')).not.toThrow();
        await svc.shutdown();
    });

    test('shutdown flushes draft and removes marker without sending', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, firstDelayMs: 60000, sender }),
        );
        await svc.start();
        svc.record('navigate');
        await svc.shutdown();
        expect(sender).not.toHaveBeenCalled();
        const drafts = path.join(stateDir, 'telemetry', 'drafts');
        const names = fs.existsSync(drafts) ? fs.readdirSync(drafts) : [];
        const draftFiles = names.filter((n) => n.startsWith('draft-') && n.endsWith('.json'));
        expect(draftFiles.length).toBe(1);
        const sessions = path.join(stateDir, 'telemetry', 'sessions');
        const sessionNames = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
        expect(sessionNames.length).toBe(0);
        await svc.shutdown();
    });

    test('extra persisted properties excluded and invalid client id quarantined', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, firstDelayMs: 1000, sender }),
        );
        await svc.start();
        fs.mkdirSync(pendingDir(stateDir), { recursive: true });
        const extraBatchId = '223e4567-e89b-42d3-a456-426614174000';
        fs.writeFileSync(
            path.join(pendingDir(stateDir), extraBatchId + '.json'),
            JSON.stringify({
                schemaVersion: 1,
                batchId: extraBatchId,
                clientId: VALID_CLIENT_ID,
                os: 'linux',
                appVersion: '1.2.3',
                actionCounts: { compile: 1 },
                debug: true,
            })
        );
        const badBatchId = '323e4567-e89b-42d3-a456-426614174000';
        fs.writeFileSync(
            path.join(pendingDir(stateDir), badBatchId + '.json'),
            JSON.stringify({
                schemaVersion: 1,
                batchId: badBatchId,
                clientId: 'not-a-uuid',
                os: 'linux',
                appVersion: '1.2.3',
                actionCounts: { compile: 9 },
            })
        );
        await advance(1000);
        expect(sender).toHaveBeenCalledTimes(1);
        const sent = sender.mock.calls[0][0];
        expect(Object.keys(sent).sort()).toEqual([
            'actionCounts',
            'appVersion',
            'batchId',
            'clientId',
            'os',
            'schemaVersion',
        ]);
        expect(fs.existsSync(path.join(pendingDir(stateDir), extraBatchId + '.json'))).toBe(false);
        expect(fs.existsSync(path.join(pendingDir(stateDir), badBatchId + '.json'))).toBe(false);
        expect(fs.existsSync(path.join(pendingDir(stateDir), badBatchId + '.json.corrupt'))).toBe(true);
        await svc.shutdown();
    });

    test('bad state path self-disables with no id or send', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const filePath = path.join(stateDir, 'not-a-dir');
        fs.writeFileSync(filePath, 'x');
        const sender = jest.fn().mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir: filePath, firstDelayMs: 1000, intervalMs: 1000, sender }),
        );
        await expect(svc.start()).resolves.toBeUndefined();
        expect(() => svc.record('compile')).not.toThrow();
        await advance(10000);
        expect(sender).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(filePath, 'client-id'))).toBe(false);
        await svc.shutdown();
    });

    test('later send cycles do not retry batches from failed attempts', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const sender = jest.fn().mockResolvedValue('retry');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, firstDelayMs: 1000, intervalMs: 21600000, sender }),
        );
        await svc.start();
        svc.record('compile');
        await advance(1000);
        expect(sender).toHaveBeenCalledTimes(1);
        await advance(21600000);
        expect(sender).toHaveBeenCalledTimes(1);
        await svc.shutdown();
    });

    test('default sender posts to the supplied endpoint with the supplied header', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as unknown as typeof fetch);
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, firstDelayMs: 1000, intervalMs: 600000 }),
        );
        try {
            await svc.start();
            svc.record('compile');
            await advance(1000);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const [url, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
            expect(url).toBe(ENDPOINT);
            expect((init.headers as Record<string, string>)[PAYLOAD_HEADER]).toBe('1');
        } finally {
            await svc.shutdown();
            fetchSpy.mockRestore();
        }
    });

    test('default sender forwards requestLogger into transport options', async () => {
        jest.useFakeTimers();
        const stateDir = makeTempDir();
        const requestLogger = jest.fn();
        const sendSpy = jest.spyOn(transport, 'sendTelemetryBatch').mockResolvedValue('acked');
        const svc = createTelemetryService<TestAction>(
            baseOptions({ stateDir, firstDelayMs: 1000, intervalMs: 600000, requestLogger }),
        );
        try {
            await svc.start();
            svc.record('compile');
            await advance(1000);
            expect(sendSpy).toHaveBeenCalledTimes(1);
            expect(sendSpy).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    endpoint: ENDPOINT,
                    payloadHeader: PAYLOAD_HEADER,
                    requestLogger,
                }),
            );
        } finally {
            await svc.shutdown();
            sendSpy.mockRestore();
        }
    });
});
