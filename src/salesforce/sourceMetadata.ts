// @salesforce/source-deploy-retrieve 12.37.2 with @salesforce/core 8.32.2.
import * as nodePath from 'node:path';
import { MetadataResolver, RegistryAccess } from '@salesforce/source-deploy-retrieve';

export type SourceStructure = 'directoryBundle' | 'other';

export type SourceComponentResolution =
    | {
        status: 'resolved';
        metadataType: string;
        componentFullName: string;
        sourceStructure: SourceStructure;
        contentPath?: string;
    }
    | { status: 'unresolved' }
    | { status: 'error'; message: string };

export interface DirectoryBundleType {
    metadataType: string;
    directoryName: string;
}

// SDR adapters that store one component as a directory of files.
const DIRECTORY_BUNDLE_ADAPTERS: ReadonlySet<string> = new Set(['bundle', 'uiBundles']);

function loadRegistryAccess(projectRoot: string): RegistryAccess {
    // SDR 12.37.2 exposes no RegistryAccess.getEffectiveRegistry entry point;
    // the constructor loads the effective registry for projectRoot instead.
    return new RegistryAccess(undefined, projectRoot);
}

function toProjectRelativePath(projectRoot: string, absolutePath: string): string | undefined {
    const relative = nodePath.relative(projectRoot, absolutePath);
    if (relative === '' || nodePath.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${nodePath.sep}`)) {
        return undefined;
    }
    return relative.split(nodePath.sep).join('/');
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}

// SDR reports both missing paths and uninferrable types as TypeInferenceError.
function isTypeInferenceError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TypeInferenceError';
}

function toSourceStructure(adapter: string | undefined): SourceStructure {
    return adapter !== undefined && DIRECTORY_BUNDLE_ADAPTERS.has(adapter) ? 'directoryBundle' : 'other';
}

export function getDirectoryBundleTypes(projectRoot: string): DirectoryBundleType[] {
    const registry = loadRegistryAccess(projectRoot).getRegistry();
    return Object.values(registry.types)
        .filter((type) => !type.aliasFor && type.strategies !== undefined && DIRECTORY_BUNDLE_ADAPTERS.has(type.strategies.adapter))
        .map((type) => ({ metadataType: type.name, directoryName: type.directoryName }));
}

export function resolveSourceComponent(projectRoot: string, requestedPath: string): SourceComponentResolution {
    let registryAccess: RegistryAccess;
    try {
        registryAccess = loadRegistryAccess(projectRoot);
    } catch (error) {
        return { status: 'error', message: errorMessage(error) };
    }
    try {
        // false disables filesystem .forceignore, so project and SDR default
        // ignore rules never filter identity resolution.
        const resolver = new MetadataResolver(registryAccess, undefined, false);
        const component = resolver.getComponentsFromPath(requestedPath)[0];
        if (!component) {
            return { status: 'unresolved' };
        }
        const resolved: Extract<SourceComponentResolution, { status: 'resolved' }> = {
            status: 'resolved',
            metadataType: component.type.name,
            componentFullName: component.fullName,
            sourceStructure: toSourceStructure(component.type.strategies?.adapter),
        };
        const contentPath = component.content ?? component.xml;
        if (contentPath) {
            const relative = toProjectRelativePath(projectRoot, contentPath);
            if (relative) {
                resolved.contentPath = relative;
            }
        }
        return resolved;
    } catch (error) {
        if (isTypeInferenceError(error)) {
            return { status: 'unresolved' };
        }
        return { status: 'error', message: errorMessage(error) };
    }
}
