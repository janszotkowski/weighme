/** A package as someone asked for it: an exact version, a dist-tag, or neither (the latest). */
export type PackageSpec = { name: string; version: string | undefined };

const MAX_NAME_LENGTH = 214;
// Capitals only exist in old packages (`JSONStream`), but those are still installed every day.
const PACKAGE_NAME = /^(?:@[a-zA-Z0-9-~][a-zA-Z0-9-._~]*\/)?[a-zA-Z0-9-~][a-zA-Z0-9-._~]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIST_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A name goes into registry URLs and file paths, so this is the only shape let through: no `..`, no second slash, no encoding. */
export const isValidPackageName = (name: string): boolean => name.length <= MAX_NAME_LENGTH && PACKAGE_NAME.test(name) && !name.split('/').some((part) => part.startsWith('.'));

export const isExactVersion = (version: string): boolean => EXACT_VERSION.test(version);

/** `react`, `react@19.1.0`, `react@next`, `@scope/name@1.2.3`. A range (`^1.0.0`) is refused: it has no single answer. */
export const parseSpec = (input: string): PackageSpec | undefined => {
    const text = input.trim();
    const at = text.lastIndexOf('@');
    const name = at > 0 ? text.slice(0, at) : text;
    const version = at > 0 ? text.slice(at + 1) : undefined;
    if (!isValidPackageName(name)) return undefined;
    if (version !== undefined && !isExactVersion(version) && !DIST_TAG.test(version)) return undefined;
    return { name, version };
};

/** What was read of a `package` parameter, or the reason it is none, in words fit for whoever sent it. */
export type PackageRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A name with or without a version or a dist-tag: what a package's cost is asked with. */
export const readPackageSpec = (input: string): PackageRead<PackageSpec> => {
    const spec = parseSpec(input);
    return spec === undefined ? { ok: false, reason: 'package must be a name with an optional exact version or dist-tag, such as react or react@19.1.0' } : { ok: true, value: spec };
};

/** A name alone: what is asked about a package whatever its version, such as its history. */
export const readPackageName = (input: string): PackageRead<string> => {
    const spec = parseSpec(input);
    return spec === undefined || spec.version !== undefined ? { ok: false, reason: 'package must be a name without a version' } : { ok: true, value: spec.name };
};

/** A name with an exact version: what is asked about one release, where a tag would have to be looked up first. */
export const readPackageRef = (input: string): PackageRead<{ name: string; version: string }> => {
    const spec = parseSpec(input);
    return spec === undefined || spec.version === undefined || !isExactVersion(spec.version)
        ? { ok: false, reason: 'package must be a name with an exact version, such as react@19.1.0' }
        : { ok: true, value: { name: spec.name, version: spec.version } };
};
