import * as SalesforceCore from '@salesforce/core';
import { describeMetadataObjects, getToolingConnection, listMetadataMembers, requestRest, resetConnectionCacheForTests } from './connection';

jest.mock('@salesforce/core', () => {
    const actual = jest.requireActual('@salesforce/core') as Record<string, unknown>;
    return {
        ...actual,
        AuthInfo: { create: jest.fn() },
        Connection: { create: jest.fn() },
    };
});

const mockAuthCreate = SalesforceCore.AuthInfo.create as unknown as jest.Mock;
const mockConnCreate = SalesforceCore.Connection.create as unknown as jest.Mock;

type MockSobject = {
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
};

type MockTooling = {
    query: jest.Mock;
    sobject: jest.Mock;
};

type MockConnection = {
    tooling: MockTooling;
    request: jest.Mock;
    metadata: { describe: jest.Mock; list: jest.Mock };
    getApiVersion: jest.Mock;
};

function createMockConnection(): MockConnection {
    const sobjects = new Map<string, MockSobject>();
    const tooling: MockTooling = {
        query: jest.fn(),
        sobject: jest.fn((type: string) => {
            let entry = sobjects.get(type);
            if (!entry) {
                entry = { create: jest.fn(), update: jest.fn(), delete: jest.fn() };
                sobjects.set(type, entry);
            }
            return entry;
        }),
    };
    return { tooling, request: jest.fn(), metadata: { describe: jest.fn(), list: jest.fn() }, getApiVersion: jest.fn(() => '62.0') };
}

beforeEach(() => {
    resetConnectionCacheForTests();
    jest.clearAllMocks();
});

describe('getToolingConnection auth and cache', () => {
    it('passes username to AuthInfo.create', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        const tooling = await getToolingConnection('C:/root', 'user@example.com');
        expect(mockAuthCreate).toHaveBeenCalledTimes(1);
        expect(mockAuthCreate).toHaveBeenCalledWith({ username: 'user@example.com' });
        expect(mockConnCreate).toHaveBeenCalledTimes(1);
        expect(tooling.wsRoot).toBe('C:/root');
        expect(tooling.username).toBe('user@example.com');
    });

    it('reuses connection for same root and username across Tooling and REST', async () => {
        const conn = createMockConnection();
        conn.tooling.query.mockResolvedValue({ records: [] });
        conn.request.mockResolvedValue({ ok: true });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        await getToolingConnection('C:/root', 'user@example.com');
        await requestRest('C:/root', 'user@example.com', {
            url: '/services/data/v67.0/composite/batch',
            method: 'POST',
            body: '{"batchRequests":[]}',
            headers: { 'Content-Type': 'application/json' },
        });
        expect(mockAuthCreate).toHaveBeenCalledTimes(1);
        expect(mockConnCreate).toHaveBeenCalledTimes(1);
    });

    it('uses separate connections for separate roots', async () => {
        const first = createMockConnection();
        const second = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        await getToolingConnection('C:/a', 'user@example.com');
        await getToolingConnection('C:/b', 'user@example.com');
        expect(mockConnCreate).toHaveBeenCalledTimes(2);
    });

    it('creates a new connection when username changes for same root', async () => {
        const first = createMockConnection();
        const second = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        await getToolingConnection('C:/root', 'one@example.com');
        await getToolingConnection('C:/root', 'two@example.com');
        expect(mockAuthCreate).toHaveBeenCalledTimes(2);
        expect(mockAuthCreate).toHaveBeenNthCalledWith(2, { username: 'two@example.com' });
        expect(mockConnCreate).toHaveBeenCalledTimes(2);
    });

    it('evicts failed creation so the next call retries', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockRejectedValueOnce(new Error('auth failed')).mockResolvedValueOnce(conn);
        await expect(getToolingConnection('C:/root', 'user@example.com')).rejects.toThrow('auth failed');
        const tooling = await getToolingConnection('C:/root', 'user@example.com');
        expect(mockConnCreate).toHaveBeenCalledTimes(2);
        expect(tooling.username).toBe('user@example.com');
    });

    it('does not expose tokens or raw auth objects', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth', secret: 'token' });
        mockConnCreate.mockResolvedValue(conn);
        const tooling = await getToolingConnection('C:/root', 'user@example.com');
        expect(Object.keys(tooling).sort()).toEqual(['create', 'delete', 'query', 'update', 'username', 'wsRoot']);
        expect(tooling).not.toHaveProperty('authInfo');
        expect(tooling).not.toHaveProperty('token');
    });
});

describe('ToolingConnection operations', () => {
    it('queries Tooling records', async () => {
        const conn = createMockConnection();
        conn.tooling.query.mockResolvedValue({ records: [{ Id: '1' }] });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        const tooling = await getToolingConnection('C:/root', 'user@example.com');
        const rows = await tooling.query<Record<string, unknown>>('SELECT Id FROM ApexClass');
        expect(conn.tooling.query).toHaveBeenCalledWith('SELECT Id FROM ApexClass');
        expect(rows).toEqual([{ Id: '1' }]);
    });

    it('creates Tooling sobject with original fields', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        const created = { id: 'a1' };
        conn.tooling.sobject('ApexClass').create.mockResolvedValue(created);
        const tooling = await getToolingConnection('C:/root', 'user@example.com');
        const fields = { Name: 'C', Body: 'cls' };
        await expect(tooling.create('ApexClass', fields)).resolves.toBe(created);
        expect(conn.tooling.sobject).toHaveBeenCalledWith('ApexClass');
        expect(conn.tooling.sobject('ApexClass').create).toHaveBeenCalledWith(fields);
    });

    it('updates Tooling sobject with Id plus fields', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        const tooling = await getToolingConnection('C:/root', 'user@example.com');
        await tooling.update('ApexClass', 'a1', { Body: 'next' });
        expect(conn.tooling.sobject).toHaveBeenCalledWith('ApexClass');
        expect(conn.tooling.sobject('ApexClass').update).toHaveBeenCalledWith({ Id: 'a1', Body: 'next' });
    });

    it('deletes Tooling sobject by id', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        const tooling = await getToolingConnection('C:/root', 'user@example.com');
        await tooling.delete('ApexClass', 'a1');
        expect(conn.tooling.sobject).toHaveBeenCalledWith('ApexClass');
        expect(conn.tooling.sobject('ApexClass').delete).toHaveBeenCalledWith('a1');
    });
});

describe('requestRest', () => {
    const restRequest = {
        url: '/services/data/v67.0/composite/batch',
        method: 'POST' as const,
        body: '{"batchRequests":[]}',
        headers: { 'Content-Type': 'application/json' },
    };

    it('calls connection.request with the relative versioned URL', async () => {
        const conn = createMockConnection();
        conn.request.mockResolvedValue({ done: true });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        await expect(requestRest('C:/root', 'user@example.com', restRequest)).resolves.toEqual({ done: true });
        expect(conn.request).toHaveBeenCalledTimes(1);
        expect(conn.request).toHaveBeenCalledWith({
            url: '/services/data/v67.0/composite/batch',
            method: 'POST',
            body: '{"batchRequests":[]}',
            headers: { 'Content-Type': 'application/json' },
        });
    });

    it('rejects when the REST request fails', async () => {
        const conn = createMockConnection();
        conn.request.mockRejectedValue(new Error('bad request'));
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        await expect(requestRest('C:/root', 'user@example.com', restRequest)).rejects.toThrow('bad request');
    });
});

describe('describeMetadataObjects', () => {
    it('normalizes metadata descriptions and drops rows with blank names', async () => {
        const conn = createMockConnection();
        conn.metadata.describe.mockResolvedValue({ metadataObjects: [
            {
                xmlName: ' CustomObject ',
                directoryName: ' objects ',
                suffix: 'object',
                inFolder: false,
                metaFile: true,
                childXmlNames: [' fields ', ' recordTypes '],
            },
            { xmlName: 'ApexClass', directoryName: 'classes' },
            { xmlName: '  ', directoryName: 'ignored' },
            { xmlName: 'Ignored', directoryName: '  ' },
        ] });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(describeMetadataObjects('C:/root', 'user@example.com')).resolves.toEqual([
            {
                xmlName: 'CustomObject',
                directoryName: 'objects',
                suffix: 'object',
                inFolder: false,
                metaFile: true,
                childXmlNames: [' fields ', ' recordTypes '],
            },
            { xmlName: 'ApexClass', directoryName: 'classes', childXmlNames: [] },
        ]);
        expect(conn.metadata.describe).toHaveBeenCalledTimes(1);
    });

    it('returns an empty description unchanged', async () => {
        const conn = createMockConnection();
        conn.metadata.describe.mockResolvedValue({ metadataObjects: [] });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(describeMetadataObjects('C:/root', 'user@example.com')).resolves.toEqual([]);
    });

    it('propagates metadata describe failures', async () => {
        const conn = createMockConnection();
        conn.metadata.describe.mockRejectedValue(new Error('describe failed'));
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(describeMetadataObjects('C:/root', 'user@example.com')).rejects.toThrow('describe failed');
    });

    it('rejects when already aborted', async () => {
        const signal = AbortSignal.abort();
        await expect(describeMetadataObjects('C:/root', 'user@example.com', signal)).rejects.toThrow('aborted');
        expect(mockAuthCreate).not.toHaveBeenCalled();
    });

    it('reuses the cached connection for the same root and username', async () => {
        const conn = createMockConnection();
        conn.metadata.describe.mockResolvedValue({ metadataObjects: [] });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await describeMetadataObjects('C:/root', 'user@example.com');
        await describeMetadataObjects('C:/root', 'user@example.com');

        expect(mockConnCreate).toHaveBeenCalledTimes(1);
        expect(conn.metadata.describe).toHaveBeenCalledTimes(2);
    });
});

describe('abort signal', () => {
    it('isolates a caller abort from shared connection creation', async () => {
        const conn = createMockConnection();
        conn.request.mockResolvedValue({ ok: true });
        let startAuth: () => void = () => undefined;
        const authStarted = new Promise<void>((resolve) => {
            startAuth = resolve;
        });
        let releaseAuth: () => void = () => undefined;
        const authGate = new Promise<void>((resolve) => {
            releaseAuth = resolve;
        });
        mockAuthCreate.mockImplementation(async () => {
            startAuth();
            await authGate;
            return { id: 'auth' };
        });
        mockConnCreate.mockResolvedValue(conn);

        const controller = new AbortController();
        const toolingPromise = getToolingConnection('C:/root', 'user@example.com', controller.signal);
        await authStarted;
        const restPromise = requestRest('C:/root', 'user@example.com', {
            url: '/services/data/v67.0/composite/batch',
            method: 'POST',
            body: '{"batchRequests":[]}',
            headers: { 'Content-Type': 'application/json' },
        });
        controller.abort();
        releaseAuth();

        await expect(toolingPromise).rejects.toThrow('aborted');
        await expect(restPromise).resolves.toEqual({ ok: true });
        expect(mockAuthCreate).toHaveBeenCalledTimes(1);
        expect(mockConnCreate).toHaveBeenCalledTimes(1);
    });

    it('prevents Tooling operations when already aborted', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        const tooling = await getToolingConnection('C:/root', 'user@example.com');
        const signal = AbortSignal.abort();
        await expect(tooling.query('SELECT Id FROM ApexClass', signal)).rejects.toThrow('aborted');
        expect(conn.tooling.query).not.toHaveBeenCalled();
    });

    it('prevents connection creation when already aborted', async () => {
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        const signal = AbortSignal.abort();
        await expect(getToolingConnection('C:/root', 'user@example.com', signal)).rejects.toThrow('aborted');
        expect(mockAuthCreate).not.toHaveBeenCalled();
    });

    it('prevents REST requests when already aborted', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);
        const signal = AbortSignal.abort();
        await expect(
            requestRest(
                'C:/root',
                'user@example.com',
                {
                    url: '/services/data/v67.0/composite/batch',
                    method: 'POST',
                    body: '{"batchRequests":[]}',
                    headers: { 'Content-Type': 'application/json' },
                },
                signal
            )
        ).rejects.toThrow('aborted');
        expect(conn.request).not.toHaveBeenCalled();
    });
});

describe('listMetadataMembers direct listing', () => {
    function mockDirectDescribe(conn: MockConnection, typeName: string): void {
        conn.metadata.describe.mockResolvedValue({ metadataObjects: [{ xmlName: typeName, inFolder: false }] });
    }

    it.each(['StandardValueSet', 'BotVersion', ' standardvalueset ', ' bOtVeRsIoN '])(
        'rejects unsupported member listing for %s before creating a connection or querying metadata',
        async (typeName) => {
            const requestedType = typeName.trim();
            const conn = createMockConnection();
            conn.metadata.describe.mockResolvedValue({ metadataObjects: [{ xmlName: requestedType, inFolder: false }] });
            conn.metadata.list.mockResolvedValue([]);
            mockAuthCreate.mockResolvedValue({ id: 'auth' });
            mockConnCreate.mockResolvedValue(conn);

            await expect(listMetadataMembers('C:/root', 'user@example.com', typeName)).rejects.toThrow(
                `Metadata member listing for type '${requestedType}' is unsupported because Metadata API list does not enumerate this type. Retrieve the full type instead of selecting individual members.`
            );
            expect(mockAuthCreate).not.toHaveBeenCalled();
            expect(mockConnCreate).not.toHaveBeenCalled();
            expect(conn.metadata.describe).not.toHaveBeenCalled();
            expect(conn.metadata.list).not.toHaveBeenCalled();
        }
    );

    it.each(['StandardValueSet', 'BotVersion'])('gives abort precedence over unsupported type %s', async (typeName) => {
        await expect(listMetadataMembers('C:/root', 'user@example.com', typeName, AbortSignal.abort())).rejects.toThrow(
            'Operation aborted.'
        );
        expect(mockAuthCreate).not.toHaveBeenCalled();
        expect(mockConnCreate).not.toHaveBeenCalled();
    });

    it('normalizes array responses with trimming, dedup, blank omission, and sorting', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'ApexClass');
        conn.metadata.list.mockResolvedValue([
            { fullName: '  MyClass  ', fileName: 'classes/MyClass.cls' },
            { fullName: 'MyClass', fileName: 'classes/MyClass.cls' },
            { fullName: '  ', fileName: 'classes/Blank.cls' },
            { fullName: 'NoFile' },
            { fullName: 'BClass', fileName: '  ' },
            { fullName: 'AClass', fileName: 'classes/AClass.cls' },
        ]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass')).resolves.toEqual([
            { fullName: 'AClass', fileName: 'classes/AClass.cls' },
            { fullName: 'BClass' },
            { fullName: 'MyClass', fileName: 'classes/MyClass.cls' },
            { fullName: 'NoFile' },
        ]);
        expect(conn.metadata.list).toHaveBeenCalledTimes(1);
        expect(conn.metadata.list).toHaveBeenCalledWith({ type: 'ApexClass' }, '62.0');
    });

    it('normalizes singleton responses', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'ApexClass');
        conn.metadata.list.mockResolvedValue({ fullName: ' Only ', fileName: 'classes/Only.cls' });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass')).resolves.toEqual([
            { fullName: 'Only', fileName: 'classes/Only.cls' },
        ]);
    });

    it('normalizes empty responses', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'ApexClass');
        conn.metadata.list.mockResolvedValue([]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass')).resolves.toEqual([]);
    });

    it('normalizes undefined responses to empty', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'ApexClass');
        conn.metadata.list.mockResolvedValue(undefined);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass')).resolves.toEqual([]);
    });

    it('retains names without fileName', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'CustomObject');
        conn.metadata.list.mockResolvedValue([{ fullName: 'Account' }, { fullName: 'Contact', fileName: 'objects/Contact.object' }]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'CustomObject')).resolves.toEqual([
            { fullName: 'Account' },
            { fullName: 'Contact', fileName: 'objects/Contact.object' },
        ]);
    });

    it('deduplicates by exact fullName only', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'ApexClass');
        conn.metadata.list.mockResolvedValue([
            { fullName: 'MyClass' },
            { fullName: 'MyClass' },
            { fullName: 'myclass' },
        ]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass')).resolves.toEqual([
            { fullName: 'MyClass' },
            { fullName: 'myclass' },
        ]);
    });

    it('reuses the cached connection for the same root and username', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'ApexClass');
        conn.metadata.list.mockResolvedValue([]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await listMetadataMembers('C:/root', 'user@example.com', 'ApexClass');
        await listMetadataMembers('C:/root', 'user@example.com', 'ApexClass');

        expect(mockConnCreate).toHaveBeenCalledTimes(1);
        expect(conn.metadata.describe).toHaveBeenCalledTimes(2);
        expect(conn.metadata.list).toHaveBeenCalledTimes(2);
    });

    it('uses separate connections for separate roots and usernames', async () => {
        const first = createMockConnection();
        first.metadata.describe.mockResolvedValue({ metadataObjects: [{ xmlName: 'ApexClass', inFolder: false }] });
        first.metadata.list.mockResolvedValue([]);
        const second = createMockConnection();
        second.metadata.describe.mockResolvedValue({ metadataObjects: [{ xmlName: 'ApexClass', inFolder: false }] });
        second.metadata.list.mockResolvedValue([]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

        await listMetadataMembers('C:/a', 'user@example.com', 'ApexClass');
        await listMetadataMembers('C:/b', 'user@example.com', 'ApexClass');
        expect(mockConnCreate).toHaveBeenCalledTimes(2);

        resetConnectionCacheForTests();
        jest.clearAllMocks();
        const third = createMockConnection();
        third.metadata.describe.mockResolvedValue({ metadataObjects: [{ xmlName: 'ApexClass', inFolder: false }] });
        third.metadata.list.mockResolvedValue([]);
        const fourth = createMockConnection();
        fourth.metadata.describe.mockResolvedValue({ metadataObjects: [{ xmlName: 'ApexClass', inFolder: false }] });
        fourth.metadata.list.mockResolvedValue([]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValueOnce(third).mockResolvedValueOnce(fourth);

        await listMetadataMembers('C:/root', 'one@example.com', 'ApexClass');
        await listMetadataMembers('C:/root', 'two@example.com', 'ApexClass');
        expect(mockConnCreate).toHaveBeenCalledTimes(2);
    });

    it('propagates describe failures', async () => {
        const conn = createMockConnection();
        conn.metadata.describe.mockRejectedValue(new Error('describe boom'));
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass')).rejects.toThrow('describe boom');
        expect(conn.metadata.list).not.toHaveBeenCalled();
    });

    it('propagates list failures', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'ApexClass');
        conn.metadata.list.mockRejectedValue(new Error('list boom'));
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass')).rejects.toThrow('list boom');
    });

    it('rejects when already aborted before describe', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass', AbortSignal.abort())).rejects.toThrow('aborted');
        expect(conn.metadata.describe).not.toHaveBeenCalled();
        expect(conn.metadata.list).not.toHaveBeenCalled();
    });

    it('makes no list call when aborted after describe', async () => {
        const conn = createMockConnection();
        const controller = new AbortController();
        conn.metadata.describe.mockImplementation(async () => {
            controller.abort();
            return { metadataObjects: [{ xmlName: 'ApexClass', inFolder: false }] };
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass', controller.signal)).rejects.toThrow('aborted');
        expect(conn.metadata.list).not.toHaveBeenCalled();
    });

    it('rejects when aborted after the member call', async () => {
        const conn = createMockConnection();
        const controller = new AbortController();
        mockDirectDescribe(conn, 'ApexClass');
        conn.metadata.list.mockImplementation(async () => {
            controller.abort();
            return [{ fullName: 'A' }];
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'ApexClass', controller.signal)).rejects.toThrow('aborted');
    });

    it('lists a described type absent from the installed registry directly', async () => {
        const conn = createMockConnection();
        conn.metadata.describe.mockResolvedValue({ metadataObjects: [{ xmlName: 'WeirdNewType999', inFolder: false }] });
        conn.metadata.list.mockResolvedValue([{ fullName: 'Thing', fileName: 'weird/Thing.foo' }]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'WeirdNewType999')).resolves.toEqual([
            { fullName: 'Thing', fileName: 'weird/Thing.foo' },
        ]);
        expect(conn.metadata.list).toHaveBeenCalledWith({ type: 'WeirdNewType999' }, '62.0');
    });

    it('rejects unsupported folder traversal instead of returning an empty list', async () => {
        const conn = createMockConnection();
        conn.metadata.describe.mockResolvedValue({ metadataObjects: [{ xmlName: 'WeirdFoldered999', inFolder: true }] });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'WeirdFoldered999')).rejects.toThrow(/folder/i);
        expect(conn.metadata.list).not.toHaveBeenCalled();
    });

    it('returns all members from a direct response with more than 1000 entries', async () => {
        const conn = createMockConnection();
        mockDirectDescribe(conn, 'ApexClass');
        const rawMembers = Array.from({ length: 1001 }, (_, index) => ({
            fullName: `Class${String(index).padStart(4, '0')}`,
        }));
        conn.metadata.list.mockResolvedValue(rawMembers);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        const members = await listMetadataMembers('C:/root', 'user@example.com', 'ApexClass');

        expect(members).toHaveLength(1001);
        expect(members[0]).toEqual({ fullName: 'Class0000' });
        expect(members[1000]).toEqual({ fullName: 'Class1000' });
    });
});

describe('listMetadataMembers folder traversal', () => {
    function mockFolderDescribe(conn: MockConnection): void {
        conn.metadata.describe.mockResolvedValue({ metadataObjects: [
            { xmlName: 'Report', inFolder: true },
            { xmlName: 'ReportFolder', inFolder: false },
        ] });
    }

    it('lists the registry folder type first then each folder members sequentially', async () => {
        const conn = createMockConnection();
        mockFolderDescribe(conn);
        conn.metadata.list.mockImplementation(async (query: { type: string; folder?: string }) => {
            if (query.type === 'ReportFolder') {
                return [{ fullName: 'Shared' }, { fullName: 'Other' }];
            }
            if (query.type === 'Report' && query.folder === 'Shared') {
                return [{ fullName: 'Shared/Q1', fileName: 'reports/Shared/Q1.report' }];
            }
            if (query.type === 'Report' && query.folder === 'Other') {
                return [{ fullName: 'Other/Q2', fileName: 'reports/Other/Q2.report' }];
            }
            throw new Error(`unexpected query ${JSON.stringify(query)}`);
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report')).resolves.toEqual([
            { fullName: 'Other/Q2', fileName: 'reports/Other/Q2.report' },
            { fullName: 'Shared/Q1', fileName: 'reports/Shared/Q1.report' },
        ]);
        expect(conn.metadata.list).toHaveBeenNthCalledWith(1, { type: 'ReportFolder' }, '62.0');
        expect(conn.metadata.list).toHaveBeenNthCalledWith(2, { type: 'Report', folder: 'Other' }, '62.0');
        expect(conn.metadata.list).toHaveBeenNthCalledWith(3, { type: 'Report', folder: 'Shared' }, '62.0');
    });

    it('preserves folder-qualified names with spaces', async () => {
        const conn = createMockConnection();
        mockFolderDescribe(conn);
        conn.metadata.list.mockImplementation(async (query: { type: string; folder?: string }) => {
            if (query.type === 'ReportFolder') return [{ fullName: 'Shared' }];
            return [{ fullName: 'Shared/Quarterly Sales', fileName: 'reports/Shared/Quarterly_Sales.report' }];
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report')).resolves.toEqual([
            { fullName: 'Shared/Quarterly Sales', fileName: 'reports/Shared/Quarterly_Sales.report' },
        ]);
    });

    it('returns empty when there are no folders without member calls', async () => {
        const conn = createMockConnection();
        mockFolderDescribe(conn);
        conn.metadata.list.mockResolvedValue([]);
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report')).resolves.toEqual([]);
        expect(conn.metadata.list).toHaveBeenCalledTimes(1);
    });

    it('propagates a folder member failure with no partial result', async () => {
        const conn = createMockConnection();
        mockFolderDescribe(conn);
        conn.metadata.list.mockImplementation(async (query: { type: string; folder?: string }) => {
            if (query.type === 'ReportFolder') return [{ fullName: 'AAA' }, { fullName: 'ZZZ' }];
            if (query.folder === 'AAA') return [{ fullName: 'AAA/R1' }];
            throw new Error('folder member boom');
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report')).rejects.toThrow('folder member boom');
        expect(conn.metadata.list).toHaveBeenNthCalledWith(1, { type: 'ReportFolder' }, '62.0');
        expect(conn.metadata.list).toHaveBeenNthCalledWith(2, { type: 'Report', folder: 'AAA' }, '62.0');
        expect(conn.metadata.list).toHaveBeenNthCalledWith(3, { type: 'Report', folder: 'ZZZ' }, '62.0');
        expect(conn.metadata.list).toHaveBeenCalledTimes(3);
    });

    it('propagates a folder list failure', async () => {
        const conn = createMockConnection();
        mockFolderDescribe(conn);
        conn.metadata.list.mockRejectedValue(new Error('folder list boom'));
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report')).rejects.toThrow('folder list boom');
    });

    it('makes no folder call when aborted after describe', async () => {
        const conn = createMockConnection();
        const controller = new AbortController();
        conn.metadata.describe.mockImplementation(async () => {
            controller.abort();
            return { metadataObjects: [{ xmlName: 'Report', inFolder: true }] };
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report', controller.signal)).rejects.toThrow('aborted');
        expect(conn.metadata.list).not.toHaveBeenCalled();
    });

    it('makes no member call when aborted after the folder call', async () => {
        const conn = createMockConnection();
        const controller = new AbortController();
        mockFolderDescribe(conn);
        conn.metadata.list.mockImplementation(async (query: { type: string; folder?: string }) => {
            if (query.type === 'ReportFolder') {
                controller.abort();
                return [{ fullName: 'Shared' }];
            }
            return [{ fullName: 'Shared/R1' }];
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report', controller.signal)).rejects.toThrow('aborted');
        expect(conn.metadata.list).toHaveBeenCalledTimes(1);
    });

    it('makes no further member calls when aborted after a member call', async () => {
        const conn = createMockConnection();
        const controller = new AbortController();
        mockFolderDescribe(conn);
        conn.metadata.list.mockImplementation(async (query: { type: string; folder?: string }) => {
            if (query.type === 'ReportFolder') return [{ fullName: 'First' }, { fullName: 'Second' }];
            if (query.folder === 'First') {
                controller.abort();
                return [{ fullName: 'First/R1' }];
            }
            return [{ fullName: 'Second/R1' }];
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report', controller.signal)).rejects.toThrow('aborted');
        expect(conn.metadata.list).toHaveBeenCalledTimes(2);
    });

    it('rejects when already aborted before any folder call', async () => {
        const conn = createMockConnection();
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report', AbortSignal.abort())).rejects.toThrow('aborted');
        expect(conn.metadata.describe).not.toHaveBeenCalled();
        expect(conn.metadata.list).not.toHaveBeenCalled();
    });

    it('returns all folder members when one folder has more than 1000 entries', async () => {
        const conn = createMockConnection();
        mockFolderDescribe(conn);
        conn.metadata.list.mockImplementation(async (query: { type: string; folder?: string }) => {
            if (query.type === 'ReportFolder') return [{ fullName: 'Big' }];
            return Array.from({ length: 1001 }, (_, index) => ({
                fullName: `Big/R${String(index).padStart(4, '0')}`,
            }));
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        const members = await listMetadataMembers('C:/root', 'user@example.com', 'Report');

        expect(members).toHaveLength(1001);
        expect(members[0]).toEqual({ fullName: 'Big/R0000' });
        expect(members[1000]).toEqual({ fullName: 'Big/R1000' });
    });

    it('processes more than 1000 folders', async () => {
        const conn = createMockConnection();
        mockFolderDescribe(conn);
        const folderNames = Array.from({ length: 1001 }, (_, index) => `Folder${String(index).padStart(4, '0')}`);
        const queriedFolders: string[] = [];
        conn.metadata.list.mockImplementation(async (query: { type: string; folder?: string }) => {
            if (query.type === 'ReportFolder') {
                return folderNames.map((fullName) => ({ fullName }));
            }
            if (query.folder) queriedFolders.push(query.folder);
            return [];
        });
        mockAuthCreate.mockResolvedValue({ id: 'auth' });
        mockConnCreate.mockResolvedValue(conn);

        await expect(listMetadataMembers('C:/root', 'user@example.com', 'Report')).resolves.toEqual([]);
        expect(conn.metadata.list).toHaveBeenCalledTimes(1002);
        expect(conn.metadata.list).toHaveBeenCalledWith({ type: 'ReportFolder' }, '62.0');
        expect(queriedFolders).toHaveLength(1001);
        expect(queriedFolders[0]).toBe('Folder0000');
        expect(queriedFolders[1000]).toBe('Folder1000');
    });
});
