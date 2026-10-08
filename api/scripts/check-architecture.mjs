import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

const root = process.cwd(), files = [];
async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (/\.(ts|js)$/.test(path) && !path.endsWith('.d.ts')) files.push(path);
    }
}
await collect(resolve('src'));
await collect(resolve('public'));
const existing = new Set(files), graph = new Map(), errors = [];
const name = file => relative(root, file).replaceAll('\\', '/');
for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const edges = [];
    for (const statement of source.statements) {
        if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
        if (statement.isTypeOnly || statement.importClause?.isTypeOnly) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings) && bindings.elements.every(element => element.isTypeOnly)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
        const dependency = existing.has(target) ? target : resolve(dirname(file), specifier);
        if (!existing.has(dependency)) continue;
        edges.push(dependency);
        const from = name(file), to = name(dependency);
        if ((from.startsWith('src/shared/') && /^src\/(modules|infrastructure|storage)\//.test(to)) ||
            (from.startsWith('src/storage/') && to.startsWith('src/modules/')) ||
            (from.endsWith('/model.ts') && (to.endsWith('/service.ts') || to.endsWith('/routes.ts'))) ||
            (from === 'public/uploads/view.js' && /^public\/uploads\/(client|controller)\.js$/.test(to)) ||
            (from === 'public/uploads/client.js' && to.startsWith('public/uploads/'))) {
            errors.push(`Forbidden dependency: ${from} -> ${to}`);
        }
    }
    graph.set(file, edges);
}
const visiting = new Set(), visited = new Set();
function visit(file, chain = []) {
    if (visiting.has(file)) { errors.push(`Runtime cycle: ${[...chain, file].map(name).join(' -> ')}`); return; }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency, [...chain, file]);
    visiting.delete(file); visited.add(file);
}
for (const file of files) visit(file);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Architecture checks passed for ${files.length} source modules.`);
