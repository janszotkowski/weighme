import { describe, expect, it } from 'vitest';
import { isValidPackageName, parseSpec, readPackageName, readPackageRef, readPackageSpec } from '@src/contract/package-spec.ts';

describe('parseSpec', () => {
    it.each([
        ['react', { name: 'react', version: undefined }],
        ['react@19.1.0', { name: 'react', version: '19.1.0' }],
        ['react@next', { name: 'react', version: 'next' }],
        ['@scope/name', { name: '@scope/name', version: undefined }],
        ['@scope/name@1.2.3-beta.1', { name: '@scope/name', version: '1.2.3-beta.1' }],
        ['  react  ', { name: 'react', version: undefined }],
    ])('reads %s', (input, expected) => {
        expect(parseSpec(input)).toEqual(expected);
    });

    it.each(['', 'react@^1.0.0', 'react@>=1', '../etc/passwd', '@scope/../x', 'a/b', '@scope/.hidden', 'https://example.com/x.tgz', 'a b', '.hidden'])('refuses %s', (input) => {
        expect(parseSpec(input)).toBeUndefined();
    });
});

describe('isValidPackageName', () => {
    it('refuses a name longer than the registry allows', () => {
        expect(isValidPackageName('a'.repeat(215))).toBe(false);
    });
});

describe('the shapes a package parameter takes', () => {
    it('reads a spec, with or without a version or a tag', () => {
        expect(readPackageSpec('react@next')).toEqual({ ok: true, value: { name: 'react', version: 'next' } });
        expect(readPackageSpec('react@^1.0.0')).toEqual({ ok: false, reason: 'package must be a name with an optional exact version or dist-tag, such as react or react@19.1.0' });
    });

    it('reads a name alone, and refuses one with a version', () => {
        expect(readPackageName(' @scope/name ')).toEqual({ ok: true, value: '@scope/name' });
        for (const input of ['react@19.1.0', 'react@next', '../etc']) expect(readPackageName(input)).toEqual({ ok: false, reason: 'package must be a name without a version' });
    });

    it('reads a name with an exact version, and refuses a tag or none', () => {
        expect(readPackageRef('react@19.1.0')).toEqual({ ok: true, value: { name: 'react', version: '19.1.0' } });
        for (const input of ['react', 'react@next', '']) expect(readPackageRef(input)).toEqual({ ok: false, reason: 'package must be a name with an exact version, such as react@19.1.0' });
    });
});
