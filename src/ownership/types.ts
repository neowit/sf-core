export type OwnershipFailureKind = 'conflict' | 'error';

export type ProjectOwnershipResult =
    | { status: 'acquired'; ownership: ProjectOwnership }
    | { status: 'conflict' }
    | { status: 'error'; error: Error };

export interface ProjectOwnership {
    readonly applicationId: string;
    readonly projectKey: string;
    readonly port: number;
    readonly closed: Promise<Error>;
    release(): Promise<void>;
}
