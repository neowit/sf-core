import type { TelemetryBatch } from './types';
import { sendTelemetryBatch, type TelemetryRequestLogger } from './transport';

const ENDPOINT = 'https://usage.invalid/collect';
const PAYLOAD_HEADER = 'X-Client-Payload-Version';

const BATCH: TelemetryBatch<'compile' | 'navigate'> = {
    schemaVersion: 1,
    batchId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    clientId: '550e8400-e29b-41d4-a716-446655440000',
    os: 'linux',
    appVersion: '1.0.0',
    actionCounts: { compile: 987654321 },
};

function mockFetch(result: unknown) {
    return jest.fn().mockImplementation(() => result) as unknown as typeof fetch;
}

describe('sendTelemetryBatch', () => {
    afterEach(() => jest.restoreAllMocks());

    it('posts to the supplied endpoint and header', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
        await sendTelemetryBatch(BATCH, {
            endpoint: ENDPOINT,
            payloadHeader: PAYLOAD_HEADER,
            fetchImpl,
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            ENDPOINT,
            expect.objectContaining({
                headers: expect.objectContaining({ [PAYLOAD_HEADER]: '1' }),
            }),
        );
    });

    test('2xx acks with exact endpoint, method, headers, and six-key body', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        const result = await sendTelemetryBatch(BATCH, {
            endpoint: ENDPOINT,
            payloadHeader: PAYLOAD_HEADER,
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(result).toBe('acked');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
        expect(url).toBe(ENDPOINT);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({
            'Content-Type': 'application/json',
            [PAYLOAD_HEADER]: '1',
        });
        const body = JSON.parse(init.body as string);
        expect(Object.keys(body).sort()).toEqual([
            'actionCounts',
            'appVersion',
            'batchId',
            'clientId',
            'os',
            'schemaVersion',
        ]);
        expect(body).toEqual({
            schemaVersion: 1,
            batchId: BATCH.batchId,
            clientId: BATCH.clientId,
            os: BATCH.os,
            appVersion: BATCH.appVersion,
            actionCounts: { compile: 987654321 },
        });
        expect(init.signal).toBeDefined();
    });

    test('logger exceptions do not prevent fetch or change ack and retry results', async () => {
        const requestLogger: TelemetryRequestLogger = () => {
            throw new Error('logger failed');
        };
        const ackFetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        const retryFetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

        await expect(
            sendTelemetryBatch(BATCH, {
                endpoint: ENDPOINT,
                payloadHeader: PAYLOAD_HEADER,
                fetchImpl: ackFetch,
                requestLogger,
            }),
        ).resolves.toBe('acked');
        await expect(
            sendTelemetryBatch(BATCH, {
                endpoint: ENDPOINT,
                payloadHeader: PAYLOAD_HEADER,
                fetchImpl: retryFetch,
                requestLogger,
            }),
        ).resolves.toBe('retry');

        expect(ackFetch).toHaveBeenCalledTimes(1);
        expect(retryFetch).toHaveBeenCalledTimes(1);
    });

    test('non-2xx resolves retry', async () => {
        await expect(
            sendTelemetryBatch(BATCH, {
                endpoint: ENDPOINT,
                payloadHeader: PAYLOAD_HEADER,
                fetchImpl: mockFetch(Promise.resolve({ ok: false, status: 500 })),
            }),
        ).resolves.toBe('retry');
        await expect(
            sendTelemetryBatch(BATCH, {
                endpoint: ENDPOINT,
                payloadHeader: PAYLOAD_HEADER,
                fetchImpl: mockFetch(Promise.resolve({ ok: false, status: 429 })),
            }),
        ).resolves.toBe('retry');
    });

    test('rejected fetch resolves retry without throwing', async () => {
        await expect(
            sendTelemetryBatch(BATCH, {
                endpoint: ENDPOINT,
                payloadHeader: PAYLOAD_HEADER,
                fetchImpl: mockFetch(Promise.reject(new Error('down'))),
            }),
        ).resolves.toBe('retry');
    });

    test('timeout abort resolves retry', async () => {
        const hanging = jest.fn(
            (_url: unknown, init?: RequestInit) =>
                new Promise((_resolve, reject) => {
                    const signal = init && init.signal;
                    if (signal) {
                        if (signal.aborted) {
                            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                            return;
                        }
                        signal.addEventListener(
                            'abort',
                            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                            { once: true },
                        );
                    }
                }),
        );
        await expect(
            sendTelemetryBatch(BATCH, {
                endpoint: ENDPOINT,
                payloadHeader: PAYLOAD_HEADER,
                timeoutMs: 20,
                fetchImpl: hanging as unknown as typeof fetch,
            }),
        ).resolves.toBe('retry');
        expect(hanging).toHaveBeenCalledTimes(1);
    });

    test('zero timeout is passed to setTimeout without using the default', async () => {
        const timer = {} as ReturnType<typeof setTimeout>;
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockReturnValue(timer);
        const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout').mockImplementation(() => undefined);

        await sendTelemetryBatch(BATCH, {
            endpoint: ENDPOINT,
            payloadHeader: PAYLOAD_HEADER,
            timeoutMs: 0,
            fetchImpl: mockFetch(Promise.resolve({ ok: true, status: 200 })),
        });

        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    });

    test('unrefs the timeout timer when supported', async () => {
        const unref = jest.fn();
        const timer = { unref } as unknown as ReturnType<typeof setTimeout>;
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockReturnValue(timer);
        const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout').mockImplementation(() => undefined);

        await sendTelemetryBatch(BATCH, {
            endpoint: ENDPOINT,
            payloadHeader: PAYLOAD_HEADER,
            fetchImpl: mockFetch(Promise.resolve({ ok: true, status: 200 })),
        });

        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
        expect(unref).toHaveBeenCalledTimes(1);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    });
});
