import * as ts from 'typescript';

/**
 * Implementation of CompilerHost that forwards all methods to another instance.
 * Useful for partial implementations to override only methods they care about.
 */
export abstract class DelegatingHost implements ts.CompilerHost {
  constructor(protected delegate: ts.CompilerHost) {}
  getSourceFile =
      (fileName: string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void) =>
          this.delegate.getSourceFile(fileName, languageVersion, onError);

  getCancellationToken = () => this.delegate.getCancellationToken();
  getDefaultLibFileName = (options: ts.CompilerOptions) =>
      this.delegate.getDefaultLibFileName(options);
  getDefaultLibLocation = () => this.delegate.getDefaultLibLocation();
  writeFile: ts.WriteFileCallback = this.delegate.writeFile;
  getCurrentDirectory = () => this.delegate.getCurrentDirectory();
  getCanonicalFileName = (fileName: string) => this.delegate.getCanonicalFileName(fileName);
  useCaseSensitiveFileNames = () => this.delegate.useCaseSensitiveFileNames();
  getNewLine = () => this.delegate.getNewLine();
  resolveModuleNames = (moduleNames: string[], containingFile: string) =>
      this.delegate.resolveModuleNames(moduleNames, containingFile);
  /**
   * This method is a companion for 'resolveModuleNames' and is used to resolve 'types' references
   * to actual type declaration files
   */
  // FIXME: need to express the optionality of this member.
  // if the delegate has it undefined, ours should be too.
  // resolveTypeReferenceDirectives =
  //   (typeReferenceDirectiveNames: string[], containingFile: string) =>
  //      this.delegate.resolveTypeReferenceDirectives(typeReferenceDirectiveNames, containingFile);

  fileExists = (fileName: string) => this.delegate.fileExists(fileName);
  readFile = (fileName: string) => this.delegate.readFile(fileName);
  trace = (s: string) => this.delegate.trace(s);
  directoryExists = (directoryName: string) => this.delegate.directoryExists(directoryName);
}
