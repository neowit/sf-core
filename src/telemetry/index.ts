export { createTelemetryService } from './service';
export type {
    TelemetryService,
    TelemetryServiceOptions,
    TelemetryServiceSender,
} from './service';
export { sendTelemetryBatch } from './transport';
export type { TelemetryRequestLogger, TelemetrySendOptions } from './transport';
export { isTelemetryAction, toTelemetryBatch } from './types';
export { TELEMETRY_SCHEMA_VERSION, TELEMETRY_PLATFORMS } from './types';
export type { ActionCounts, TelemetryBatch } from './types';
export { createTelemetryStore } from './store';
export type { TelemetryStore, TelemetryStoreOptions } from './store';
export { loadOrCreateClientId, purgeTelemetryState, isProcessAlive } from './state';
