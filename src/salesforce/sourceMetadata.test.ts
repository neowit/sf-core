import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import {
    getDirectoryBundleTypes,
    resolveSourceComponent,
} from './sourceMetadata';

const UIBUNDLE_META_XML = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<UIBundle xmlns="http://soap.sforce.com/2006/04/metadata">',
    '<description>Fixture bundle</description>',
    '</UIBundle>',
    '',
].join('\n');

const APEX_META_XML = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">',
    '<apiVersion>60.0</apiVersion>',
    '<status>Active</status>',
    '</ApexClass>',
    '',
].join('\n');

const WAVE_META_XML = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<WaveTemplateBundle xmlns="http://soap.sforce.com/2006/04/metadata">',
    '<description>Fixture template</description>',
    '</WaveTemplateBundle>',
    '',
].join('\n');

const fixtureRoots: string[] = [];

function writeFile(projectRoot: string, relativePath: string, contents: string): string {
    const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
    return absolutePath;
}

function createFixtureProject(extraProjectJson: Record<string, unknown> = {}): string {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-core-source-metadata-'));
    fixtureRoots.push(projectRoot);
    fs.writeFileSync(
        path.join(projectRoot, 'sfdx-project.json'),
        JSON.stringify({
            packageDirectories: [{ path: 'force-app', default: true }],
            sourceApiVersion: '60.0',
            ...extraProjectJson,
        }),
    );
    return projectRoot;
}

function createBundleFixture(projectRoot: string, bundleDirName = 'uiBundles'): { bundleRoot: string; welcomePath: string; dotMemberPath: string; metaPath: string } {
    const bundleBase = `force-app/main/default/${bundleDirName}/Foo`;
    const bundleRoot = path.join(projectRoot, ...bundleBase.split('/'));
    const metaPath = writeFile(projectRoot, `${bundleBase}/Foo.uibundle-meta.xml`, UIBUNDLE_META_XML);
    const welcomePath = writeFile(projectRoot, `${bundleBase}/src/pages/Welcome.tsx`, 'export const Welcome = () => null;\n');
    // SDR default ignores deny dot files; identity resolution must ignore that.
    const dotMemberPath = writeFile(projectRoot, `${bundleBase}/.config/settings.json`, '{}\n');
    return { bundleRoot, welcomePath, dotMemberPath, metaPath };
}

describe('sourceMetadata', () => {
    afterEach(() => {
        for (const root of fixtureRoots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    describe('resolveSourceComponent', () => {
        it('resolves a nested UIBundle member despite project and default ignores', () => {
            const projectRoot = createFixtureProject();
            const { welcomePath } = createBundleFixture(projectRoot);
            writeFile(projectRoot, '.forceignore', 'force-app/main/default/uiBundles/Foo/**\n');

            expect(resolveSourceComponent(projectRoot, welcomePath)).toEqual({
                status: 'resolved',
                metadataType: 'UIBundle',
                componentFullName: 'Foo',
                sourceStructure: 'directoryBundle',
                contentPath: 'force-app/main/default/uiBundles/Foo',
            });
        });

        it('resolves a member under a default-ignore directory to the same bundle', () => {
            const projectRoot = createFixtureProject();
            const { dotMemberPath } = createBundleFixture(projectRoot);

            expect(resolveSourceComponent(projectRoot, dotMemberPath)).toMatchObject({
                status: 'resolved',
                metadataType: 'UIBundle',
                componentFullName: 'Foo',
                sourceStructure: 'directoryBundle',
                contentPath: 'force-app/main/default/uiBundles/Foo',
            });
        });

        it('resolves the bundle meta file to the bundle component', () => {
            const projectRoot = createFixtureProject();
            const { metaPath } = createBundleFixture(projectRoot);

            expect(resolveSourceComponent(projectRoot, metaPath)).toMatchObject({
                status: 'resolved',
                metadataType: 'UIBundle',
                componentFullName: 'Foo',
                sourceStructure: 'directoryBundle',
            });
        });

        it('resolves an existing component root to the same bundle identity', () => {
            const projectRoot = createFixtureProject();
            const { bundleRoot } = createBundleFixture(projectRoot);
            writeFile(projectRoot, '.forceignore', 'force-app/main/default/uiBundles/Foo/**\n');

            expect(resolveSourceComponent(projectRoot, bundleRoot)).toEqual({
                status: 'resolved',
                metadataType: 'UIBundle',
                componentFullName: 'Foo',
                sourceStructure: 'directoryBundle',
                contentPath: 'force-app/main/default/uiBundles/Foo',
            });
        });

        it('resolves a generic bundle member and component root to the same identity', () => {
            const projectRoot = createFixtureProject();
            const bundleBase = 'force-app/main/default/waveTemplates/MyTemplate';
            writeFile(projectRoot, `${bundleBase}/MyTemplate.waveTemplateBundle-meta.xml`, WAVE_META_XML);
            const nestedPath = writeFile(projectRoot, `${bundleBase}/src/data.json`, '{}\n');
            const bundleRoot = path.join(projectRoot, ...bundleBase.split('/'));

            const expected = {
                status: 'resolved',
                metadataType: 'WaveTemplateBundle',
                componentFullName: 'MyTemplate',
                sourceStructure: 'directoryBundle',
                contentPath: 'force-app/main/default/waveTemplates/MyTemplate',
            };
            expect(resolveSourceComponent(projectRoot, nestedPath)).toEqual(expected);
            expect(resolveSourceComponent(projectRoot, bundleRoot)).toEqual(expected);
        });

        it('resolves a non-bundle component with the other structure', () => {
            const projectRoot = createFixtureProject();
            const classPath = writeFile(projectRoot, 'force-app/main/default/classes/MyClass.cls', 'public class MyClass {}');
            writeFile(projectRoot, 'force-app/main/default/classes/MyClass.cls-meta.xml', APEX_META_XML);

            expect(resolveSourceComponent(projectRoot, classPath)).toEqual({
                status: 'resolved',
                metadataType: 'ApexClass',
                componentFullName: 'MyClass',
                sourceStructure: 'other',
                contentPath: 'force-app/main/default/classes/MyClass.cls',
            });
        });

        it('returns unresolved for an ordinary non-metadata file', () => {
            const projectRoot = createFixtureProject();
            const notesPath = writeFile(projectRoot, 'force-app/main/default/docs/notes/todo.txt', 'notes\n');

            expect(resolveSourceComponent(projectRoot, notesPath)).toEqual({ status: 'unresolved' });
        });

        it('returns unresolved for a missing file without scanning ancestors', () => {
            const projectRoot = createFixtureProject();
            createBundleFixture(projectRoot);
            const missingPath = path.join(projectRoot, 'force-app', 'main', 'default', 'uiBundles', 'Missing', 'nope.tsx');

            expect(resolveSourceComponent(projectRoot, missingPath)).toEqual({ status: 'unresolved' });
        });

        it('returns an error for unexpected registry failures', () => {
            const projectRoot = createFixtureProject({ sourceBehaviorOptions: ['not-a-real-preset'] });
            const requestedPath = path.join(projectRoot, 'force-app', 'main', 'default', 'classes', 'MyClass.cls');

            const result = resolveSourceComponent(projectRoot, requestedPath);
            expect(result.status).toBe('error');
            expect((result as { message: string }).message).toMatch('not-a-real-preset');
        });

        it('honors the effective project registry customization', () => {
            const standardUiBundle = new RegistryAccess().getTypeByName('uibundle');
            const projectRoot = createFixtureProject({
                registryCustomizations: {
                    types: { uibundle: { ...standardUiBundle, directoryName: 'customBundles' } },
                },
            });
            const { welcomePath } = createBundleFixture(projectRoot, 'customBundles');

            expect(resolveSourceComponent(projectRoot, welcomePath)).toMatchObject({
                status: 'resolved',
                metadataType: 'UIBundle',
                componentFullName: 'Foo',
                sourceStructure: 'directoryBundle',
                contentPath: 'force-app/main/default/customBundles/Foo',
            });
            expect(getDirectoryBundleTypes(projectRoot)).toContainEqual({
                metadataType: 'UIBundle',
                directoryName: 'customBundles',
            });
        });
    });

    describe('getDirectoryBundleTypes', () => {
        it('lists bundle and uiBundles adapters with registry directory names', () => {
            const projectRoot = createFixtureProject();

            const types = getDirectoryBundleTypes(projectRoot);
            expect(types).toContainEqual({ metadataType: 'UIBundle', directoryName: 'uiBundles' });
            expect(types).toContainEqual({ metadataType: 'WaveTemplateBundle', directoryName: 'waveTemplates' });
            for (const entry of types) {
                expect(typeof entry.metadataType).toBe('string');
                expect(entry.metadataType.length).toBeGreaterThan(0);
                expect(typeof entry.directoryName).toBe('string');
                expect(entry.directoryName.length).toBeGreaterThan(0);
            }
        });

        it('excludes DigitalExperienceBundle', () => {
            const projectRoot = createFixtureProject();

            expect(getDirectoryBundleTypes(projectRoot).some((type) => type.metadataType === 'DigitalExperienceBundle')).toBe(false);
        });

        it('throws unexpected registry failures instead of returning an empty list', () => {
            const projectRoot = createFixtureProject({ sourceBehaviorOptions: ['not-a-real-preset'] });

            expect(() => getDirectoryBundleTypes(projectRoot)).toThrow('not-a-real-preset');
        });
    });
});
