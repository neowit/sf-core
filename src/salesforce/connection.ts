// @salesforce/core 8.21.0; use the package-root CommonJS-safe namespace import.
import * as SalesforceCore from '@salesforce/core';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';

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

export interface MetadataObjectDescription {
    xmlName: string;
    directoryName: string;
    suffix?: string;
    inFolder?: boolean;
    metaFile?: boolean;
    childXmlNames: string[];
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

async function createRawConnection(username: string): Promise<RawConnection> {
    const authInfo = await SalesforceCore.AuthInfo.create({ username });
    return SalesforceCore.Connection.create({ authInfo });
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
    const connection = createRawConnection(username);
    const entry: CacheEntry = { username, connection };
    connectionCache.set(wsRoot, entry);
    void connection.catch(() => {
        if (connectionCache.get(wsRoot) === entry) connectionCache.delete(wsRoot);
    });
    return connection.then((rawConnection) => {
        checkAborted(signal);
        return rawConnection;
    });
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

export async function describeMetadataObjects(
    wsRoot: string,
    username: string,
    signal?: AbortSignal
): Promise<MetadataObjectDescription[]> {
    checkAborted(signal);
    const connection = await getCachedRawConnection(wsRoot, username, signal);
    checkAborted(signal);
    const { metadataObjects } = await connection.metadata.describe();
    checkAborted(signal);
    return metadataObjects.flatMap((description) => {
        const xmlName = description.xmlName?.trim();
        const directoryName = description.directoryName?.trim();
        if (!xmlName || !directoryName) return [];
        return [{
            xmlName,
            directoryName,
            ...(description.suffix != null ? { suffix: description.suffix } : {}),
            ...(description.inFolder !== undefined ? { inFolder: description.inFolder } : {}),
            ...(description.metaFile !== undefined ? { metaFile: description.metaFile } : {}),
            childXmlNames: description.childXmlNames ?? [],
        }];
    });
}

export function resetConnectionCacheForTests(): void {
    connectionCache.clear();
}

export interface MetadataComponentMember {
    fullName: string;
    fileName?: string;
}

// listMetadata() accepts up to 3 queries per call with no pagination support
// (https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_listmetadata.htm).
// Treat a full page as potentially incomplete and force type-wide retrieve.
const LIST_RESULT_LIMIT = 1000;

function cappedListError(typeName: string): Error {
    return new Error(
        `Metadata list for type '${typeName}' reached the ${LIST_RESULT_LIMIT}-item limit and may be incomplete. ` +
        'Retry the listing or retrieve the full type instead of selecting individual members.'
    );
}

function normalizeMembers(raw: unknown): { members: MetadataComponentMember[]; rawCount: number } {
    const entries: unknown[] = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    const seen = new Set<string>();
    const members: MetadataComponentMember[] = [];
    for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const fullNameValue = (entry as { fullName?: unknown }).fullName;
        if (typeof fullNameValue !== 'string') continue;
        const fullName = fullNameValue.trim();
        if (!fullName || seen.has(fullName)) continue;
        seen.add(fullName);
        const fileNameValue = (entry as { fileName?: unknown }).fileName;
        if (typeof fileNameValue === 'string' && fileNameValue.trim()) {
            members.push({ fullName, fileName: fileNameValue.trim() });
        } else {
            members.push({ fullName });
        }
    }
    members.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
    return { members, rawCount: entries.length };
}

export async function listMetadataMembers(
    wsRoot: string,
    username: string,
    typeName: string,
    signal?: AbortSignal
): Promise<MetadataComponentMember[]> {
    checkAborted(signal);
    const requestedType = typeName.trim();
    if (['standardvalueset', 'botversion'].includes(requestedType.toLowerCase())) {
        throw new Error(
            `Metadata member listing for type '${requestedType}' is unsupported because Metadata API list does not enumerate this type. ` +
            'Retrieve the full type instead of selecting individual members.'
        );
    }
    const connection = await getCachedRawConnection(wsRoot, username, signal);
    checkAborted(signal);
    const { metadataObjects } = await connection.metadata.describe();
    checkAborted(signal);
    const described = Array.isArray(metadataObjects)
        ? metadataObjects.find((item) => item?.xmlName?.trim() === requestedType)
            ?? metadataObjects.find((item) => item?.xmlName?.trim().toLowerCase() === requestedType.toLowerCase())
        : undefined;
    const inFolder = described?.inFolder === true;
    const apiVersion = connection.getApiVersion();
    if (!inFolder) {
        checkAborted(signal);
        const raw = await connection.metadata.list({ type: requestedType }, apiVersion);
        checkAborted(signal);
        const normalized = normalizeMembers(raw);
        if (normalized.rawCount >= LIST_RESULT_LIMIT) throw cappedListError(requestedType);
        return normalized.members;
    }
    let registryAccess: RegistryAccess | undefined;
    try {
        registryAccess = new RegistryAccess(undefined, wsRoot);
    } catch {
        registryAccess = undefined;
    }
    let folderTypeName: string | undefined;
    if (registryAccess) {
        try {
            const registryType = registryAccess.getTypeByName(requestedType);
            const folderTypeId = registryType?.folderType;
            if (folderTypeId) {
                folderTypeName = registryAccess.getTypeByName(folderTypeId).name;
            }
        } catch {
            folderTypeName = undefined;
        }
    }
    if (!folderTypeName) {
        throw new Error(
            `Metadata type '${requestedType}' is stored in folders but the local registry does not define a folder type. ` +
            'Retrieve the full type instead of selecting individual members.'
        );
    }
    checkAborted(signal);
    const rawFolders = await connection.metadata.list({ type: folderTypeName }, apiVersion);
    checkAborted(signal);
    const folders = normalizeMembers(rawFolders);
    if (folders.rawCount >= LIST_RESULT_LIMIT) throw cappedListError(folderTypeName);
    if (folders.members.length === 0) return [];
    const collected = new Map<string, MetadataComponentMember>();
    for (const folder of folders.members) {
        checkAborted(signal);
        const rawMembers = await connection.metadata.list({ type: requestedType, folder: folder.fullName }, apiVersion);
        checkAborted(signal);
        const normalized = normalizeMembers(rawMembers);
        if (normalized.rawCount >= LIST_RESULT_LIMIT) throw cappedListError(requestedType);
        for (const member of normalized.members) {
            if (!collected.has(member.fullName)) collected.set(member.fullName, member);
        }
    }
    return [...collected.values()].sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
}
