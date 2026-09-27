// @salesforce/core 8.21.0; use the package-root CommonJS-safe namespace import.
import * as SalesforceCore from '@salesforce/core';

export interface ToolingConnection {
    readonly wsRoot: string;
    readonly username: string;
    query<T extends Record<string, unknown>>(soql: string, signal?: AbortSignal): Promise<T[]>;
    create<T extends Record<string, unknown>>(
        objectType: string,
        fields: Record<string, unknown>,
        signal?: AbortSignal
    ): Promise<T>;
    update(objectType: string, id: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
    delete(objectType: string, id: string, signal?: AbortSignal): Promise<void>;
}

export interface RestRequest {
    url: string;
    method: 'POST';
    body: string;
    headers: Record<string, string>;
}

type RawConnection = Awaited<ReturnType<typeof SalesforceCore.Connection.create>>;

type CacheEntry = {
    username: string;
    connection: Promise<RawConnection>;
};

const connectionCache = new Map<string, CacheEntry>();

function checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Operation aborted.');
}

async function createRawConnection(username: string, signal?: AbortSignal): Promise<RawConnection> {
    checkAborted(signal);
    const authInfo = await SalesforceCore.AuthInfo.create({ username });
    checkAborted(signal);
    const connection = await SalesforceCore.Connection.create({ authInfo });
    checkAborted(signal);
    return connection;
}

function getCachedRawConnection(wsRoot: string, username: string, signal?: AbortSignal): Promise<RawConnection> {
    checkAborted(signal);
    const current = connectionCache.get(wsRoot);
    if (current?.username === username) {
        return current.connection.then((connection) => {
            checkAborted(signal);
            return connection;
        });
    }
    const connection = createRawConnection(username, signal);
    const entry: CacheEntry = { username, connection };
    connectionCache.set(wsRoot, entry);
    void connection.catch(() => {
        if (connectionCache.get(wsRoot) === entry) connectionCache.delete(wsRoot);
    });
    return connection;
}

function wrapConnection(wsRoot: string, username: string, connection: RawConnection): ToolingConnection {
    const tooling = connection.tooling;
    return {
        wsRoot,
        username,
        async query<T extends Record<string, unknown>>(soql: string, signal?: AbortSignal): Promise<T[]> {
            checkAborted(signal);
            const result = await tooling.query(soql);
            checkAborted(signal);
            return result.records as unknown as T[];
        },
        async create<T extends Record<string, unknown>>(
            objectType: string,
            fields: Record<string, unknown>,
            signal?: AbortSignal
        ): Promise<T> {
            checkAborted(signal);
            const result = await tooling.sobject(objectType).create(fields as never);
            checkAborted(signal);
            return result as unknown as T;
        },
        async update(objectType: string, id: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
            checkAborted(signal);
            await tooling.sobject(objectType).update({ Id: id, ...fields } as never);
            checkAborted(signal);
        },
        async delete(objectType: string, id: string, signal?: AbortSignal): Promise<void> {
            checkAborted(signal);
            await tooling.sobject(objectType).delete(id);
            checkAborted(signal);
        },
    };
}

export async function getToolingConnection(
    wsRoot: string,
    username: string,
    signal?: AbortSignal
): Promise<ToolingConnection> {
    checkAborted(signal);
    const connection = await getCachedRawConnection(wsRoot, username, signal);
    checkAborted(signal);
    return wrapConnection(wsRoot, username, connection);
}

export async function requestRest<T>(
    wsRoot: string,
    username: string,
    request: RestRequest,
    signal?: AbortSignal
): Promise<T> {
    checkAborted(signal);
    const connection = await getCachedRawConnection(wsRoot, username, signal);
    checkAborted(signal);
    const result = await connection.request<T>(request);
    checkAborted(signal);
    return result;
}

export function resetConnectionCacheForTests(): void {
    connectionCache.clear();
}
