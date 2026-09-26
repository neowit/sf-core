import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import type { ProjectOwnership, ProjectOwnershipResult } from './types';

interface ProjectOwnershipOptions {
    applicationId: string;
    projectRoot: string;
}

const PORT_START = 20000;
const PORT_COUNT = 10000;

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

async function deriveIdentity(options: ProjectOwnershipOptions): Promise<{ projectKey: string; port: number }> {
    if (!options.applicationId.trim()) throw new Error('applicationId must not be empty');
    const physicalRoot = await fs.realpath(options.projectRoot);
    const normalizedRoot = path.normalize(physicalRoot);
    const keyInput = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
    const projectKey = createHash('sha256').update(options.applicationId).update('\0').update(keyInput).digest('hex');
    const portHash = createHash('sha256').update(projectKey).digest();
    const port = PORT_START + (portHash.readUInt32BE(0) % PORT_COUNT);
    return { projectKey, port };
}

export function resolveProjectOwnershipIdentity(options: ProjectOwnershipOptions): Promise<{ projectKey: string; port: number }> {
    return deriveIdentity(options);
}

export async function acquireProjectOwnership(options: ProjectOwnershipOptions): Promise<ProjectOwnershipResult> {
    let identity: { projectKey: string; port: number };
    try {
        identity = await deriveIdentity(options);
    } catch (error) {
        return { status: 'error', error: toError(error) };
    }

    const server = net.createServer((socket) => socket.destroy());
    let resolveClosed!: (error: Error) => void;
    const closed = new Promise<Error>((resolve) => { resolveClosed = resolve; });
    let acquired = false;
    let releasing = false;
    let releasePromise: Promise<void> | undefined;

    const onError = (error: Error): void => {
        if (!acquired) return;
        resolveClosed(error);
    };
    const onClose = (): void => {
        if (!acquired || releasing) return;
        resolveClosed(new Error('Project ownership listener closed unexpectedly'));
    };
    server.on('error', onError);
    server.on('close', onClose);

    const listenResult = await new Promise<{ status: 'listening' } | { status: 'error'; error: Error }>((resolve) => {
        const onListenError = (error: NodeJS.ErrnoException): void => {
            server.removeListener('listening', onListening);
            resolve({ status: 'error', error });
        };
        const onListening = (): void => {
            server.removeListener('error', onListenError);
            resolve({ status: 'listening' });
        };
        server.once('error', onListenError);
        server.once('listening', onListening);
        try {
            server.listen({ host: '127.0.0.1', port: identity.port, exclusive: true, reusePort: false });
        } catch (error) {
            server.removeListener('error', onListenError);
            server.removeListener('listening', onListening);
            resolve({ status: 'error', error: toError(error) });
        }
    });

    if (listenResult.status !== 'listening') {
        server.removeListener('error', onError);
        server.removeListener('close', onClose);
        return (listenResult.error as NodeJS.ErrnoException).code === 'EADDRINUSE'
            ? { status: 'conflict' }
            : { status: 'error', error: listenResult.error };
    }

    acquired = true;
    const ownership: ProjectOwnership = {
        applicationId: options.applicationId,
        projectKey: identity.projectKey,
        port: identity.port,
        closed,
        release(): Promise<void> {
            if (releasePromise) return releasePromise;
            releasing = true;
            releasePromise = new Promise<void>((resolve, reject) => {
                if (!server.listening) {
                    resolve();
                    return;
                }
                try {
                    server.close((error) => error ? reject(error) : resolve());
                } catch (error) {
                    if (!server.listening) resolve();
                    else reject(error);
                }
            });
            return releasePromise;
        },
    };
    return { status: 'acquired', ownership };
}
