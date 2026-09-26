import type { TelemetryBatch } from './types';

const DEFAULT_TIMEOUT_MS = 5000;
const TELEMETRY_REQUEST_LOGGING = false;

export type TelemetryRequestLogger = (message: string) => void;

export type TelemetrySendOptions = {
    endpoint: string;
    payloadHeader: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    requestLogger?: TelemetryRequestLogger;
};

export async function sendTelemetryBatch<Action extends string>(
    batch: TelemetryBatch<Action>,
    opts: TelemetrySendOptions,
): Promise<'acked' | 'retry'> {
    const endpoint = opts.endpoint;
    const payloadHeader = opts.payloadHeader;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const requestLogger = opts.requestLogger;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    try {
        if (TELEMETRY_REQUEST_LOGGING && requestLogger) {
            try {
                requestLogger(`[telemetry] attempt ${endpoint}`);
            } catch {
                // Diagnostic failures must not affect the request.
            }
        }
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [payloadHeader]: '1',
            },
            body: JSON.stringify(batch),
            signal: controller.signal,
        });
        if (TELEMETRY_REQUEST_LOGGING && requestLogger) {
            try {
                requestLogger(`[telemetry] response status=${response.status}`);
            } catch {
                // Diagnostic failures must not affect the request.
            }
        }
        return response.ok ? 'acked' : 'retry';
    } catch (error) {
        if (TELEMETRY_REQUEST_LOGGING && requestLogger) {
            try {
                const name = error instanceof Error ? error.name : typeof error;
                const message = error instanceof Error ? error.message : String(error);
                requestLogger(`[telemetry] network error name=${name} message=${message}`);
            } catch {
                // Diagnostic failures must not affect the request.
            }
        }
        return 'retry';
    } finally {
        clearTimeout(timer);
    }
}
