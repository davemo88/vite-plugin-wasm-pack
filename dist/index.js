"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const chalk_1 = __importDefault(require("chalk"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const narrowing_1 = require("narrowing");
const path_1 = __importDefault(require("path"));
/**
 *   return a Vite plugin for handling wasm-pack crate
 *
 *   only use local crate
 *
 *   import wasmPack from 'vite-plugin-wasm-pack';
 *
 *   plugins: [wasmPack(['./my-local-crate'])]
 *
 *   only use npm crate, leave the first param to an empty array
 *
 *   plugins: [wasmPack([],['test-npm-crate'])]
 *
 *   use both local and npm crate
 *
 *   plugins: [wasmPack(['./my-local-crate'],['test-npm-crate'])]
 *
 * @param crates local crates paths, if you only use crates from npm, leave an empty array here.
 * @param moduleCrates crates names from npm
 */
function vitePluginWasmPack(crates, moduleCrates) {
    const prefix = '@vite-plugin-wasm-pack@';
    const pkg = 'pkg'; // default folder of wasm-pack module
    let config_base;
    let config_assetsDir;
    const cratePaths = (0, narrowing_1.isString)(crates) ? [crates] : crates;
    const modulePaths = !moduleCrates
        ? []
        : (0, narrowing_1.isString)(moduleCrates)
            ? [moduleCrates]
            : moduleCrates;
    // from ../../my-crate  ->  my_crate_bg.wasm
    const wasmFilename = (cratePath) => {
        return path_1.default.basename(cratePath).replace(/\-/g, '_') + '_bg.wasm';
    };
    // wasmfileName : CrateType
    const wasmMap = new Map();
    // 'my_crate_bg.wasm': {path:'../../my_crate/pkg/my_crate_bg.wasm', isNodeModule: false}
    cratePaths.forEach((cratePath) => {
        const wasmFile = wasmFilename(cratePath);
        wasmMap.set(wasmFile, {
            path: path_1.default.join(cratePath, pkg, wasmFile),
            isNodeModule: false
        });
    });
    // 'my_crate_bg.wasm': { path: 'node_modules/my_crate/my_crate_bg.wasm', isNodeModule: true }
    modulePaths.forEach((cratePath) => {
        const wasmFile = wasmFilename(cratePath);
        const wasmDirectory = path_1.default.dirname(require.resolve(cratePath));
        wasmMap.set(wasmFile, {
            path: path_1.default.join(wasmDirectory, wasmFile),
            isNodeModule: true
        });
    });
    return {
        name: 'vite-plugin-wasm-pack',
        enforce: 'pre',
        configResolved(resolvedConfig) {
            config_base = resolvedConfig.base;
            config_assetsDir = resolvedConfig.build.assetsDir;
        },
        resolveId(id) {
            for (let i = 0; i < cratePaths.length; i++) {
                if (path_1.default.basename(cratePaths[i]) === id)
                    return prefix + id;
            }
            return null;
        },
        async load(id) {
            if (id.indexOf(prefix) === 0) {
                id = id.replace(prefix, '');
                const modulejs = path_1.default.join('./node_modules', id, id.replace(/\-/g, '_') + '.js');
                const code = await fs_extra_1.default.promises.readFile(modulejs, {
                    encoding: 'utf-8'
                });
                return code;
            }
        },
        async buildStart(_inputOptions) {
            const prepareBuild = async (cratePath, isNodeModule) => {
                const pkgPath = isNodeModule
                    ? path_1.default.dirname(require.resolve(cratePath))
                    : path_1.default.join(cratePath, pkg);
                const crateName = path_1.default.basename(cratePath);
                if (!fs_extra_1.default.existsSync(pkgPath)) {
                    if (isNodeModule) {
                        console.error(chalk_1.default.bold.red('Error: ') +
                            `Can't find ${chalk_1.default.bold(pkgPath)}, run ${chalk_1.default.bold.red(`npm install ${cratePath}`)} first`);
                    }
                    else {
                        console.error(chalk_1.default.bold.red('Error: ') +
                            `Can't find ${chalk_1.default.bold(pkgPath)}, run ${chalk_1.default.bold.red(`wasm-pack build ${cratePath} --target web`)} first`);
                    }
                }
                if (!isNodeModule) {
                    // copy pkg generated by wasm-pack to node_modules
                    try {
                        await fs_extra_1.default.copy(pkgPath, path_1.default.join('node_modules', crateName));
                    }
                    catch (error) {
                        this.error(`copy crates failed: ${error}`);
                    }
                }
                // replace default load path with '/assets/xxx.wasm'
                const jsName = crateName.replace(/\-/g, '_') + '.js';
                /**
                 * if use node module and name is '@group/test'
                 * cratePath === '@group/test'
                 * crateName === 'test'
                 */
                let jsPath = path_1.default.join('./node_modules', crateName, jsName);
                if (isNodeModule) {
                    jsPath = path_1.default.join(pkgPath, jsName);
                }
                const regex = /input = new URL\('(.+)'.+;/g;
                let code = fs_extra_1.default.readFileSync(path_1.default.resolve(jsPath), { encoding: 'utf-8' });
                code = code.replace(regex, (_match, group1) => {
                    return `input = "${path_1.default.posix.join(config_base, config_assetsDir, group1)}"`;
                });
                fs_extra_1.default.writeFileSync(jsPath, code);
            };
            for await (const cratePath of cratePaths) {
                await prepareBuild(cratePath, false);
            }
            for await (const cratePath of modulePaths) {
                await prepareBuild(cratePath, true);
            }
        },
        configureServer({ middlewares }) {
            // send 'root/pkg/xxx.wasm' file to user
            middlewares.use((req, res, next) => {
                if ((0, narrowing_1.isString)(req.url)) {
                    const basename = path_1.default.basename(req.url);
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    const entry = wasmMap.get(basename);
                    if (basename.endsWith('.wasm') && entry) {
                        res.writeHead(200, { 'Content-Type': 'application/wasm' });
                        fs_extra_1.default.createReadStream(entry.path).pipe(res);
                    }
                    else {
                        next();
                    }
                }
            });
        },
        buildEnd() {
            // copy xxx.wasm files to /assets/xxx.wasm
            wasmMap.forEach((crate, fileName) => {
                this.emitFile({
                    type: 'asset',
                    fileName: `assets/${fileName}`,
                    source: fs_extra_1.default.readFileSync(crate.path)
                });
            });
        }
    };
}
exports.default = vitePluginWasmPack;
// https://github.com/sveltejs/vite-plugin-svelte/issues/214
if (typeof module !== 'undefined') {
    module.exports = vitePluginWasmPack;
    vitePluginWasmPack.default = vitePluginWasmPack;
}
