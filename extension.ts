// src/extension.ts

import * as vscode from "vscode";
import * as path from "path";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

/**
 * Resolve VS Code style variables and workspace relative paths
 * in the configured LSP command.
 *
 * Supported variables:
 *  - ${workspaceFolder}
 *  - ${workspaceFolderBasename}
 *
 * Behavior:
 *  - If the value has no slashes (for example "shrimpl-lsp"), it is treated
 *    as a plain command on PATH and returned as is.
 *  - If the value has slashes and is not absolute, it is resolved under the
 *    first workspace folder.
 */
function resolveServerCommand(
  rawValue: string,
  outputChannel: vscode.OutputChannel
): string {
  const trimmed = rawValue.trim();

  const folders = vscode.workspace.workspaceFolders;
  let wsPath: string | undefined;
  let wsName: string | undefined;

  if (folders && folders.length > 0) {
    wsPath = folders[0].uri.fsPath;
    wsName = folders[0].name;
  }

  let resolved = trimmed;

  if (wsPath) {
    resolved = resolved.replace(/\$\{workspaceFolder\}/g, wsPath);
  }
  if (wsName) {
    resolved = resolved.replace(
      /\$\{workspaceFolderBasename\}/g,
      wsName
    );
  }

  const hasSlash = resolved.includes("/") || resolved.includes("\\");
  const isAbsolute = path.isAbsolute(resolved);

  // If it looks like a path (has a slash) and is not absolute yet,
  // resolve under the workspace folder if available.
  if (hasSlash && !isAbsolute && wsPath) {
    resolved = path.join(wsPath, resolved);
  }

  outputChannel.appendLine(
    `[Shrimpl] Raw LSP command from settings: ${rawValue}`
  );
  outputChannel.appendLine(
    `[Shrimpl] Resolved LSP command to: ${resolved}`
  );

  return resolved;
}

/**
 * Get the command to use for the Shrimpl language server.
 * Falls back to "shrimpl-lsp" if the setting is empty.
 */
function getServerCommand(
  outputChannel: vscode.OutputChannel
): string {
  const config = vscode.workspace.getConfiguration("shrimpl");
  const value =
    config.get<string>("lsp.path")?.trim() || "shrimpl-lsp";
  return resolveServerCommand(value, outputChannel);
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Shrimpl");
  const traceOutputChannel =
    vscode.window.createOutputChannel("Shrimpl LSP Trace");

  const serverCommand = getServerCommand(outputChannel);

  const serverOptions: ServerOptions = {
    command: serverCommand,
    args: [],
    options: {
      env: {
        ...process.env,
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "shrimpl" },
      { scheme: "untitled", language: "shrimpl" },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher(
        "**/*.shr"
      ),
    },
    outputChannel,
    traceOutputChannel,
  };

  client = new LanguageClient(
    "shrimplLanguageServer",
    "Shrimpl Language Server",
    serverOptions,
    clientOptions
  );

  try {
    outputChannel.appendLine(
      "[Shrimpl] Starting language server..."
    );

    // Register the client itself for disposal
    context.subscriptions.push(client);

    // Start the client, resolves when server is ready
    await client.start();

    outputChannel.appendLine(
      "[Shrimpl] Language server is ready."
    );
    vscode.window.showInformationMessage(
      "[Shrimpl] Language server started."
    );
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(
      `[Shrimpl] Failed to start language server: ${msg}`
    );
    vscode.window.showErrorMessage(
      `[Shrimpl] Failed to start language server: ${msg}`
    );
  }

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("shrimpl.lsp.path")) {
        outputChannel.appendLine(
          "[Shrimpl] Configuration 'shrimpl.lsp.path' changed. Please reload VS Code to restart the language server with the new path."
        );
        vscode.window.showInformationMessage(
          "[Shrimpl] 'shrimpl.lsp.path' changed. Reload the window to apply the new language server path."
        );
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  if (!client) {
    return;
  }

  try {
    await client.stop();
  } finally {
    client = undefined;
  }
}
