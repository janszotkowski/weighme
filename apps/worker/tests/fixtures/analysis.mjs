// Stands in for the process of one analysis: the package's name says how it behaves.
const RESULT = {
    bundler: { name: 'rolldown', version: '1.0.0' },
    entry: 'export-star',
    commands: [],
    composition: { packages: [], total: 0 },
    sizes: { minified: 300, gzip: 200, brotli: 100 },
    install: { bytes: 1000, packages: 1 },
    peerDependencies: [],
    description: null,
    environment: { nodeBuiltins: [], nativeAddons: 0, unresolvedImports: 0 },
    repositoryUrl: null,
    timingsMs: { install: 1, bundle: 1, compress: 1 },
};

const EXPORTS = { format: 'esm', sideEffectsFree: true, named: [], namedTotal: 0, namedFailed: 0, subpaths: [], subpathsTotal: 0, subpathsFailed: 0, subpathPatterns: 0 };

const send = (message) =>
    new Promise((resolve) => {
        process.send?.(message, () => resolve());
    });

process.once('message', (request) => {
    void (async () => {
        const behaviour = request.package.name;
        if (behaviour === 'dies-at-once') process.exit(3);
        if (behaviour === 'hangs') return;
        await send({ kind: 'result', result: RESULT });
        if (behaviour === 'dies-after-the-result') process.exit(0);
        await send({ kind: 'exports', exports: EXPORTS });
        process.exit(0);
    })();
});

// Keeps the process alive when nothing else does.
setInterval(() => undefined, 1000);
