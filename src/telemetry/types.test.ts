import { isTelemetryAction, isTelemetryNumericField, toTelemetryBatch } from './types';

const ACTIONS = ['compile', 'navigate'] as const;
type Action = (typeof ACTIONS)[number];

const VALID_BATCH = {
    schemaVersion: 1 as const,
    batchId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    clientId: '550e8400-e29b-41d4-a716-446655440000',
    os: 'win32',
    appVersion: '1.0.0',
    actionCounts: { compile: 2 },
};

describe('telemetry types', () => {
    it('accepts only actions from the supplied list', () => {
        expect(isTelemetryAction('compile', ACTIONS)).toBe(true);
        expect(isTelemetryAction('navigate', ACTIONS)).toBe(true);
        for (const action of ACTIONS) {
            expect(isTelemetryAction(action, ACTIONS)).toBe(true);
        }
    });

    it('rejects unlisted and non-string values', () => {
        expect(isTelemetryAction('unknown', ACTIONS)).toBe(false);
        expect(isTelemetryAction('archive', ACTIONS)).toBe(false);
        expect(isTelemetryAction(undefined, ACTIONS)).toBe(false);
        expect(isTelemetryAction(null, ACTIONS)).toBe(false);
        expect(isTelemetryAction(42, ACTIONS)).toBe(false);
        expect(isTelemetryAction({}, ACTIONS)).toBe(false);
    });

    it('validates batches against the supplied action list', () => {
        const parsed = toTelemetryBatch(
            { ...VALID_BATCH, actionCounts: { compile: 2, unknown: 4 } },
            ACTIONS,
        );
        expect(parsed?.actionCounts).toEqual({ compile: 2 });
    });

    it('rebuilds clean payloads and drops unknown top-level properties', () => {
        expect(
            toTelemetryBatch(
                {
                    ...VALID_BATCH,
                    actionCounts: { compile: 2 },
                    extra: 'drop me',
                    counts: { compile: 99 },
                },
                ACTIONS,
            ),
        ).toEqual(VALID_BATCH);
    });

    it('returns exactly the six schema keys', () => {
        const parsed = toTelemetryBatch(VALID_BATCH, ACTIONS);
        expect(parsed).not.toBeNull();
        expect(Object.keys(parsed as object).sort()).toEqual([
            'actionCounts',
            'appVersion',
            'batchId',
            'clientId',
            'os',
            'schemaVersion',
        ]);
    });

    it('keeps only explicitly allowlisted safe numeric top-level fields', () => {
        const field = 'apexsense-ready-in-sec';
        expect(
            toTelemetryBatch({ ...VALID_BATCH, [field]: 11, debug: true }, ACTIONS, [field]),
        ).toEqual({ ...VALID_BATCH, [field]: 11 });
        expect(toTelemetryBatch({ ...VALID_BATCH, [field]: 0 }, ACTIONS, [field])).toEqual({
            ...VALID_BATCH,
            [field]: 0,
        });
        for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '11']) {
            expect(toTelemetryBatch({ ...VALID_BATCH, [field]: bad }, ACTIONS, [field])).toEqual(
                VALID_BATCH,
            );
        }
        expect(toTelemetryBatch({ ...VALID_BATCH, [field]: 11 }, ACTIONS)).toEqual(VALID_BATCH);
    });

    it('does not allow reserved keys or unlisted numeric fields', () => {
        expect(isTelemetryNumericField('clientId', 8, ['clientId'])).toBe(false);
        expect(isTelemetryNumericField('__proto__', 8, ['__proto__'])).toBe(false);
        expect(isTelemetryNumericField('debug', 8, ['metric'])).toBe(false);
        expect(
            toTelemetryBatch(
                { ...VALID_BATCH, clientId: 8, metric: 8 },
                ACTIONS,
                ['clientId', 'metric'],
            ),
        ).toBeNull();
    });

    it('keeps valid non-negative safe-integer counts including zero', () => {
        const parsed = toTelemetryBatch(
            {
                ...VALID_BATCH,
                actionCounts: { compile: 0, navigate: 987654321 },
            },
            ACTIONS,
        );
        expect(parsed?.actionCounts).toEqual({ compile: 0, navigate: 987654321 });
    });

    it('filters invalid counts and unknown actions', () => {
        const parsed = toTelemetryBatch(
            {
                ...VALID_BATCH,
                actionCounts: {
                    compile: 1,
                    navigate: -1,
                    unknown: 5,
                    bogus: 5,
                },
            },
            ACTIONS,
        );
        expect(parsed?.actionCounts).toEqual({ compile: 1 });
    });

    it('filters non-integer, non-safe-integer, and non-number counts', () => {
        const parsed = toTelemetryBatch(
            {
                ...VALID_BATCH,
                actionCounts: {
                    compile: 1.5,
                    navigate: Number.MAX_SAFE_INTEGER + 1,
                },
            },
            ACTIONS,
        );
        expect(parsed?.actionCounts).toEqual({});
        const stringCount = toTelemetryBatch(
            { ...VALID_BATCH, actionCounts: { compile: '2' } },
            ACTIONS,
        );
        expect(stringCount?.actionCounts).toEqual({});
    });

    it('rejects untrusted persisted values', () => {
        const valid = { ...VALID_BATCH, actionCounts: { compile: 1 } };
        expect(toTelemetryBatch({ ...valid, batchId: 'not-a-uuid' }, ACTIONS)).toBe(null);
        expect(toTelemetryBatch({ ...valid, clientId: 'c1' }, ACTIONS)).toBe(null);
        expect(toTelemetryBatch({ ...valid, os: 'plan9' }, ACTIONS)).toBe(null);
        expect(toTelemetryBatch({ ...valid, appVersion: '../evil 1.0' }, ACTIONS)).toBe(null);
        expect(toTelemetryBatch({ ...valid, appVersion: 'unknown' }, ACTIONS)).toEqual({
            ...valid,
            appVersion: 'unknown',
        });
        expect(
            toTelemetryBatch(
                { ...valid, actionCounts: { compile: 1, bogus: 5, navigate: -1 } },
                ACTIONS,
            ),
        ).toEqual({ ...valid, actionCounts: { compile: 1 } });
    });

    it('rejects malformed envelopes', () => {
        expect(toTelemetryBatch(null, ACTIONS)).toBe(null);
        expect(toTelemetryBatch([], ACTIONS)).toBe(null);
        expect(toTelemetryBatch('batch', ACTIONS)).toBe(null);
        expect(toTelemetryBatch({ schemaVersion: 1, batchId: 'b1' }, ACTIONS)).toBe(null);
        expect(toTelemetryBatch({ ...VALID_BATCH, schemaVersion: 2 }, ACTIONS)).toBe(null);
        expect(toTelemetryBatch({ ...VALID_BATCH, actionCounts: null }, ACTIONS)).toBe(null);
        expect(toTelemetryBatch({ ...VALID_BATCH, actionCounts: [] }, ACTIONS)).toBe(null);
    });

    it('keeps the action type narrow', () => {
        const action: Action = 'compile';
        expect(action).toBe('compile');
    });
});
