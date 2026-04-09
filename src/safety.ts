import * as nodePath from "node:path";
import * as fs from "node:fs";

/**
 * Safety error for boundary violations and resource limits
 */
export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

/**
 * Validate that a file path is within the project root boundary
 * Prevents path traversal attacks and symlink escapes
 *
 * @param inputPath - Path to validate (can be relative or absolute)
 * @param projectRoot - Absolute path to project root
 * @throws SafetyError if path is outside project root
 *
 */
export function validatePath(inputPath: string, projectRoot: string): void {
  // Resolve the input path relative to project root
  const resolved = nodePath.resolve(projectRoot, inputPath);

  // Check for path traversal using separator to prevent prefix bugs
  // Example: /project should not validate for /projects/other
  const isExactMatch = resolved === projectRoot;
  const isWithinProject = resolved.startsWith(projectRoot + nodePath.sep);

  if (!isExactMatch && !isWithinProject) {
    throw new SafetyError(
      `Path outside project root: ${inputPath} resolves to ${resolved}`
    );
  }

  // Check for symlink escape
  // For write operations, the file might not exist yet (ENOENT is acceptable)
  try {
    const real = fs.realpathSync(resolved);

    const isRealExactMatch = real === projectRoot;
    const isRealWithinProject = real.startsWith(projectRoot + nodePath.sep);

    if (!isRealExactMatch && !isRealWithinProject) {
      throw new SafetyError(
        `Symlink escape detected: ${inputPath} resolves to ${real} outside project root`
      );
    }
  } catch (error) {
    // Handle ENOENT for write operations (file doesn't exist yet)
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // File doesn't exist yet - this is acceptable for write operations
      // The resolved path check above is sufficient
      return;
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Validate that a file size is within the configured limit
 *
 * @param filePath - Path to the file to check
 * @param maxFileSizeKb - Maximum file size in kilobytes
 * @throws SafetyError if file exceeds size limit
 *
 */
export function validateFileSize(
  filePath: string,
  maxFileSizeKb: number
): void {
  try {
    const stats = fs.statSync(filePath);
    const fileSizeKb = stats.size / 1024;

    if (fileSizeKb > maxFileSizeKb) {
      throw new SafetyError(
        `File size exceeds limit: ${filePath} is ${fileSizeKb.toFixed(2)}KB, max is ${maxFileSizeKb}KB`
      );
    }
  } catch (error) {
    if (error instanceof SafetyError) {
      throw error;
    }

    // If file doesn't exist or can't be read, let the caller handle it
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new SafetyError(`File not found: ${filePath}`);
    }

    throw error;
  }
}

/**
 * Validate that a patch size (number of files) is within the configured limit
 *
 * @param fileCount - Number of files in the patch
 * @param maxFilesPerPatch - Maximum number of files allowed per patch
 * @throws SafetyError if patch exceeds file count limit
 *
 */
export function validatePatchSize(
  fileCount: number,
  maxFilesPerPatch: number
): void {
  if (fileCount > maxFilesPerPatch) {
    throw new SafetyError(
      `Patch size exceeds limit: ${fileCount} files, max is ${maxFilesPerPatch}`
    );
  }
}

/**
 * Extract the binary name from a shell command string
 * Handles quoted commands and arguments
 *
 * @param command - Shell command string
 * @returns Binary name (first token)
 */
function extractBinary(command: string): string {
  const trimmed = command.trim();

  // Handle quoted commands
  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1);
    if (endQuote !== -1) {
      return trimmed.substring(1, endQuote);
    }
  }

  if (trimmed.startsWith("'")) {
    const endQuote = trimmed.indexOf("'", 1);
    if (endQuote !== -1) {
      return trimmed.substring(1, endQuote);
    }
  }

  // Extract first token (split on whitespace)
  const tokens = trimmed.split(/\s+/);
  return tokens[0] || "";
}

/**
 * Validate that a shell command is in the allowlist
 * Only the binary name is checked, not arguments
 *
 * @param command - Shell command to validate
 * @param allowedCommands - List of allowed binary names
 * @throws SafetyError if command is not in allowlist
 *
 */
export function validateShellCommand(
  command: string,
  allowedCommands: string[]
): void {
  const binary = extractBinary(command);

  if (!binary) {
    throw new SafetyError("Empty shell command");
  }

  if (!allowedCommands.includes(binary)) {
    throw new SafetyError(
      `Shell command not allowed: ${binary}. Allowed commands: ${allowedCommands.join(", ")}`
    );
  }
}

