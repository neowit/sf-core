import * as SalesforceCore from '@salesforce/core';
import { describeMetadataObjects, getToolingConnection, requestRest, resetConnectionCacheForTests } from './connection';

jest.mock('@salesforce/core', () => ({
    AuthInfo: { create: jest.fn() },
    Connection: { create: jest.fn() },
}));

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
    metadata: { describe: jest.Mock };
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
    return { tooling, request: jest.fn(), metadata: { describe: jest.fn() } };
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
