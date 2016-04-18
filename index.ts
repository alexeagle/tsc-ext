var mkdirp = require('mkdirp');
import {DelegatingHost} from './delegating_host';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const DEBUG = true;

export interface Extension {
  /**
   * Configuration options supplied in tsconfig.json
   */
  options: {
    // Location where generated sources are written.
    // Separate from emitted outputs because these should be included in rootDirs
    genDir?: string

    // Extensions may add their own options as well.
  };

  /**
   * For source modification extensions.
   */
  preProcess?(program: ts.Program, sourceFile: ts.SourceFile):
      {content: string; diagnostics: ts.Diagnostic[];};
  postProcess?(fileName: string, content: string): string;

  /**
   * For generating additional inputs to the compilation.
   */
  codegen?(writeFile: (filePath: string, content: string) => void): void;

  /**
   * Static analysis checks beyond type-checking.
   */
  check?(): void;
}

interface DebugExtension extends Extension {
  name: string;
  loadPath: string;
}

export function formatDiagnostics(diags: ts.Diagnostic[]): string {
  return diags
      .map((d) => {
        let res = ts.DiagnosticCategory[d.category];
        if (d.file) {
          res += ' at ' + d.file.fileName + ':';
          const {line, character} = d.file.getLineAndCharacterOfPosition(d.start);
          res += (line + 1) + ':' + (character + 1) + ':';
        }
        res += ' ' + ts.flattenDiagnosticMessageText(d.messageText, '\n');
        return res;
      })
      .join('\n');
}

function check(diagnostics: ts.Diagnostic[]) {
  if (diagnostics && diagnostics.length && diagnostics[0]) {
    console.error('FATAL', formatDiagnostics(diagnostics));
    process.exit(1);
  }
}

function debug(msg: string, ...o: any[]) {
  if (DEBUG) console.log(msg, ...o);
}

function enabled(extensionPoint: string): (ext: Extension) => boolean {
  return (ext) => {
    const extension = ext as DebugExtension;
    const result = !!ext[extensionPoint];
    if (result) {
      debug(`Executing ${extensionPoint} from extension ${extension.name}`);
    } else {
      debug(`Extension ${extension.name} does not provide ${extensionPoint}`);
    }
    return result;
  }
}

class ExtCompilerHost extends DelegatingHost {
  // Additional diagnostics gathered by pre- and post-emit transformations.
  public diagnostics: ts.Diagnostic[] = [];
  public program: ts.Program;

  constructor(
      delegate: ts.CompilerHost, private options: ts.CompilerOptions,
      private extensions: Extension[]) {
    super(delegate);
  }

  // Workaround angular/angular#8082
  // Collect a reverse mapping from each resolved module path to the requested module name.
  // Allows us to reverse the moduleResolution.
  private reverseMap: {[filename: string]: string} = {};
  resolveModuleNames = (moduleNames: string[], containingFile: any) => {
    const result: ts.ResolvedModule[] = [];
    moduleNames.forEach(moduleName => {
      const resolved =
          ts.resolveModuleName(moduleName, containingFile, this.options, this.delegate);
      if (resolved.resolvedModule) {
        result.push(resolved.resolvedModule);
        this.reverseMap[resolved.resolvedModule.resolvedFileName] = moduleName;
      }
    });
    return result;
  };

  getSourceFile =
      (fileName: string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void) => {
        const sourceFile = this.delegate.getSourceFile(fileName, languageVersion, onError);

        let isDefinitions = /\.d\.ts$/.test(fileName);
        if (isDefinitions) return sourceFile;

        let content: string = this.readFile(fileName);
        this.extensions.filter(enabled('preProcess')).forEach(ext => {
          // FIXME: last extension should not win...
          const result = ext.preProcess(this.program, sourceFile);
          this.diagnostics.push(...result.diagnostics);
          content = result.content;
        });
        return ts.createSourceFile(fileName, content, languageVersion, true);
      }

  writeFile =
      (fileName: string, content: string, writeByteOrderMark: boolean,
       onError?: (message: string) => void) => {
        this.extensions.filter(enabled('postProcess')).forEach(ext => {
          content = ext.postProcess(fileName, content);
        });
        this.delegate.writeFile(fileName, content, writeByteOrderMark, onError);
      }
}

function load(extensionsCfg: any): Extension[] {
  const result: DebugExtension[] = [];
  if (!extensionsCfg) return result;

  for (const extension of Object.keys(extensionsCfg)) {
    try {
      const ext = require(extension).default;
      ext.options = extensionsCfg[extension];
      ext.name = extension;
      ext.loadPath = require.resolve(extension);
      result.push(ext);
    } catch (e) {
      console.error(`Unable to load extension ${extension}. Is the npm module installed?`);
    }
  }
  return result;
}

export function main(project: string, basePath?: string): number {
  basePath = basePath || project;
  let diagnostics: ts.Diagnostic[] = [];

  // Allow a directory containing tsconfig.json as the project value
  if (fs.lstatSync(project).isDirectory()) {
    project = path.join(project, 'tsconfig.json');
  }

  const {config, error} = ts.readConfigFile(project, f => fs.readFileSync(f, 'utf-8'));
  check([error]);

  const extensionsCfg = config.extentions;
  const extensions = load(config.extensions);
  delete config.extensions;

  const parsed =
      ts.parseJsonConfigFileContent(config, {readDirectory: ts.sys.readDirectory}, basePath);
  check(parsed.errors);

  let delegateHost = ts.createCompilerHost(parsed.options, true);
  let compilerHost = new ExtCompilerHost(delegateHost, parsed.options, extensions);
  let program = ts.createProgram(parsed.fileNames, parsed.options, compilerHost);

  // This dependency looks backwards, but Sickle needs it
  compilerHost.program = program;
  check(program.getOptionsDiagnostics());

  function isCompilationTarget(sf: ts.SourceFile) {
    // later optimization: only type-check files that are immediate inputs to the program,
    // not our dependencies.
    return true;
  }

  extensions.filter(enabled('codegen'))
      .forEach(ext => ext.codegen((filename: string, source: string) => {
        let outDir: string;
        if (ext.options.genDir) {
          outDir = path.join(basePath, ext.options.genDir);
        } else {
          outDir = parsed.options.outDir;
        }
        const dest = path.join(outDir, filename);
        mkdirp.sync(path.dirname(dest));
        fs.writeFileSync(dest, source);
        debug(`[tsc-ext] Wrote ${dest}`);
      }));

  check(program.getGlobalDiagnostics());

  for (let sf of program.getSourceFiles()) {
    if (isCompilationTarget(sf)) {
      diagnostics.push(...ts.getPreEmitDiagnostics(program, sf));
    }
  }
  check(diagnostics);
  check(compilerHost.diagnostics);

  // Type-check
  check(ts.getPreEmitDiagnostics(program));

  extensions.filter(enabled('check')).forEach(ext => ext.check());

  let failed = false;
  for (let sf of program.getSourceFiles()) {
    if (isCompilationTarget(sf)) {
      let {diagnostics, emitSkipped} = program.emit(sf);
      diagnostics.push(...diagnostics);
      failed = failed || emitSkipped;
    }
  }
  check(diagnostics);
  return failed ? 1 : 0;
}

// CLI entry point
if (require.main === module) {
  const args = require('minimist')(process.argv.slice(2));
  try {
    process.exit(main(args.p || args.project || '.', args.basePath));
  } catch (e) {
    console.error('FATAL', e.message, e.stack);
    process.exit(1);
  }
}
