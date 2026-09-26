export type ActionCounts<Action extends string> = Partial<Record<Action, number>>;

export type TelemetryBatch<Action extends string> = {
    schemaVersion: 1;
    batchId: string;
    clientId: string;
    os: string;
    appVersion: string;
    actionCounts: ActionCounts<Action>;
} & Record<string, unknown>;

export const TELEMETRY_SCHEMA_VERSION = 1;

export const TELEMETRY_PLATFORMS = ['darwin', 'linux', 'win32'] as const;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const APP_VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;

export function isTelemetryAction<Action extends string>(
    value: unknown,
    actions: readonly Action[],
): value is Action {
    return typeof value === 'string' && (actions as readonly string[]).includes(value);
}

const RESERVED_TELEMETRY_FIELDS = [
    'schemaVersion', 'batchId', 'clientId', 'os', 'appVersion', 'actionCounts',
    '__proto__', 'prototype', 'constructor',
];

export function isTelemetryNumericField(
    field: string,
    value: unknown,
    fields: readonly string[],
): value is number {
    return fields.includes(field) && !RESERVED_TELEMETRY_FIELDS.includes(field) &&
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function toTelemetryBatch<Action extends string>(
    raw: unknown,
    actions: readonly Action[],
    numericFields: readonly string[] = [],
): TelemetryBatch<Action> | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return null;
    }
    const obj = raw as Record<string, unknown>;
    if (obj['schemaVersion'] !== TELEMETRY_SCHEMA_VERSION) {
        return null;
    }
    const batchId = obj['batchId'];
    if (typeof batchId !== 'string' || !UUID_V4_RE.test(batchId)) {
        return null;
    }
    const clientId = obj['clientId'];
    if (typeof clientId !== 'string' || !UUID_V4_RE.test(clientId)) {
        return null;
    }
    const os = obj['os'];
    if (typeof os !== 'string' || !(TELEMETRY_PLATFORMS as readonly string[]).includes(os)) {
        return null;
    }
    const appVersion = obj['appVersion'];
    if (typeof appVersion !== 'string' || !APP_VERSION_RE.test(appVersion)) {
        return null;
    }
    const actionCounts = obj['actionCounts'];
    if (typeof actionCounts !== 'object' || actionCounts === null || Array.isArray(actionCounts)) {
        return null;
    }
    const clean: ActionCounts<Action> = {};
    for (const [key, value] of Object.entries(actionCounts as Record<string, unknown>)) {
        if (!isTelemetryAction(key, actions)) {
            continue;
        }
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
            continue;
        }
        clean[key] = value;
    }
    const cleanBatch: TelemetryBatch<Action> = {
        schemaVersion: 1, batchId, clientId, os, appVersion, actionCounts: clean,
    };
    for (const field of numericFields) {
        if (isTelemetryNumericField(field, obj[field], numericFields)) {
            cleanBatch[field] = obj[field];
        }
    }
    return cleanBatch;
}
