# Shrimpl Language Server for VS Code

This extension adds full **Shrimpl language** support to VS Code:

* Syntax highlighting and basic editor configuration for `.shr` files.
* A **Language Server Protocol (LSP)** backend implemented in Rust (`shrimpl-lsp`).
* Live diagnostics, hover help, keyword snippets, and document symbols for Shrimpl APIs.

This document is aimed at contributors who want to understand how the LSP works and how to extend it.

---

## 1. Architecture overview

The Shrimpl tooling is split across two projects:

* **Core language + LSP backend**
  Repository: `shrimpl-language`

  * Library crate: parser, AST, interpreter, docs/diagnostics.
  * Binary: `shrimpl-lsp` (Rust, uses `tower-lsp`).

* **VS Code extension** (this repo)

  * TypeScript code that starts `shrimpl-lsp` as a child process.
  * Wires the process to VS Code via `vscode-languageclient`.
  * Provides grammar, language configuration, icons, and activation.

Communication is standard LSP over stdin/stdout:

```text
VS Code (client) ── JSON-RPC over stdio ──► shrimpl-lsp (Rust)
      ▲                                          │
      │                                          ├─ uses shrimpl parser + docs
      └────────── extension.ts (LanguageClient) ─┘
```

At a high level:

1. VS Code opens a `.shr` file → the extension activates.
2. The extension resolves a command for `shrimpl-lsp` and spawns the binary.
3. `shrimpl-lsp` parses and analyzes the Shrimpl program and returns diagnostics, hovers, completions, etc.
4. VS Code renders those results in the editor.

---

## 2. Repository layout (extension)

Typical top-level structure:

```text
lsp-shrimpl-lang/
  .vscode/
    launch.json          # Debug config for running the extension
    settings.json        # Workspace settings, including shrimpl.lsp.path
  icons/
    shr.png              # File icon for .shr files
  out/
    extension.js         # Compiled JS (generated)
  syntaxes/
    shrimpl.tmLanguage.json
  extension.ts           # Main TypeScript entry point
  icon-theme.json        # VS Code icon theme contribution
  language-configuration.json
  package.json           # Extension manifest
  package-lock.json
  tsconfig.json
  LICENSE
  README.md              # (this file)
```

The important parts for LSP development are:

* `extension.ts` – activation and `LanguageClient` wiring.
* `.vscode/settings.json` – where we point to the `shrimpl-lsp` binary.
* `.vscode/launch.json` – VS Code run/debug configuration.
* `syntaxes/*.json` and `language-configuration.json` – syntax highlighting and editor behavior.

---

## 3. How the client starts the language server

The key logic lives in `extension.ts`.

On activation (when a `.shr` file is opened), the extension:

1. Resolves the **server command** (path to `shrimpl-lsp`).
2. Builds `ServerOptions` for `vscode-languageclient` using that command.
3. Creates a `LanguageClient` instance and starts it.

### 3.1 Resolving the server command

There is a helper that takes the config value `shrimpl.lsp.path` and expands placeholders like:

* `${workspaceFolder}` – the root of the workspace.
* `${workspaceFolderBasename}` – just the folder name.

This lets you configure paths such as:

```jsonc
// .vscode/settings.json
{
  "shrimpl.lsp.path": "${workspaceFolder}/../shrimpl-language/target/debug/shrimpl-lsp"
}
```

If the setting is not provided, the client falls back to plain `"shrimpl-lsp"` and relies on `PATH`.

The extension logs messages like:

```text
[Shrimpl] Using LSP command from settings 'shrimpl.lsp.path': ${workspaceFolder}/../shrimpl-language/target/debug/shrimpl-lsp
[Shrimpl] Starting language server...
```

These show up in the VS Code Output panel under the Shrimpl channel.

### 3.2 Language client wiring

In `extension.ts` a `LanguageClient` is created with:

* `documentSelector` targeting the Shrimpl language (id `"shrimpl"`).
* `ServerOptions` wrapping the resolved command and args.
* Client options like `synchronize` and `outputChannel`.

The client is started in `activate()` and disposed in `deactivate()`. Adding new LSP methods on the Rust side usually does **not** require changes in the client.

---

## 4. Rust language server (shrimpl-lsp) – behavior

The Rust implementation lives in the `shrimpl-language` repo, binary `src/bin/shrimpl_lsp.rs`. It uses `tower-lsp` and the shared Shrimpl modules.

### 4.1 Core imports and backend state

```rust
use shrimpl::docs;
use shrimpl::parser::ast::Program;
use shrimpl::parser::parse_program;
use tower_lsp::lsp_types::*;

#[derive(Debug)]
struct Backend {
    client: Client,
    documents: Arc<Mutex<HashMap<Url, String>>>,
}
```

* `client` – used to send diagnostics, logs, etc. back to VS Code.
* `documents` – in-memory cache of open documents (URI → full text).

`Backend::new(client)` constructs this state; it is instantiated once in `main()` when building the `LspService`.

### 4.2 Document lifecycle

The server implements the usual text document notifications:

* `did_open` – store the text and analyze.
* `did_change` – update the stored text and analyze again. We use **full document sync** so the last change contains the full file contents.
* `did_save` – if the client sends the text, we re-analyze using that.
* `did_close` – remove the document from the cache and clear diagnostics.

Each of these calls:

```rust
self.update_document(uri, text).await;
```

`update_document` stores the text in `documents` and then calls `reanalyze`.

### 4.3 Parsing and diagnostics (`reanalyze`)

```rust
async fn reanalyze(&self, uri: Url, text: String) {
    // 1) Parse
    let (mut diagnostics, program_opt) = analyze_source(text);

    // 2) Static diagnostics from docs::build_diagnostics
    if let Some(program) = program_opt {
        let diags_json: Value = docs::build_diagnostics(&program);
        diagnostics.extend(convert_static_diagnostics(&diags_json));
    }

    // 3) Publish
    let _ = self.client.publish_diagnostics(uri, diagnostics, None).await;
}
```

#### `analyze_source`

* Calls `parse_program(&source)` from the shared parser.
* On success → returns `(vec![], Some(program))`.
* On failure → attempts to parse an error message of the form `"Line N: ..."` and converts it into a single `Diagnostic`:

  * Line numbers are converted to **0-based** for LSP.
  * The diagnostic currently covers columns 0..200 for that line.

#### `convert_static_diagnostics`

`docs::build_diagnostics(&program)` returns JSON like:

```json
{
  "errors": [ { "message": "...", "kind": "error" } ],
  "warnings": [ { "message": "...", "kind": "warning" } ]
}
```

`convert_static_diagnostics`:

* Reads `errors` and `warnings` arrays.
* For each entry, chooses `DiagnosticSeverity::ERROR` or `WARNING` based on the `kind` field.
* Creates an LSP `Diagnostic` at position `(0, 0)` → `(0, 1)` (we do not yet have exact positions here).

If you enhance `docs::build_diagnostics` with line/column data, this function is where you would wire that into precise `Range` values.

---

## 5. Outline model and document symbols

Hover and document symbols are backed by a lightweight **outline** built by scanning the raw text, without running the full parser.

### 5.1 Outline data structures

```rust
#[derive(Debug, Clone)]
struct ServerOutline { /* server <port> */ }

#[derive(Debug, Clone)]
struct EndpointOutline { /* endpoint METHOD "path" */ }

#[derive(Debug, Clone)]
struct FunctionOutline { /* func name(args): expr */ }

#[derive(Debug, Clone)]
struct MethodOutline { /* class method(args): expr */ }

#[derive(Debug, Clone)]
struct ClassOutline { /* class Name: ... */ }

#[derive(Debug, Clone)]
struct Outline {
    server: Option<ServerOutline>,
    endpoints: Vec<EndpointOutline>,
    functions: Vec<FunctionOutline>,
    classes: Vec<ClassOutline>,
}
```

### 5.2 Building the outline (`parse_outline`)

`parse_outline(text: &str) -> Outline`:

* Splits the document into lines.
* Tracks each line’s index (`line`) and indentation (`start_char`).
* Recognizes patterns:

  * `server <port>`
  * `endpoint METHOD "path"`
  * `func name(args):`
  * `class Name:` plus indented method lines below it.
* For each match, records:

  * `line` (0-based).
  * `start_char` / `end_char` (columns).
  * For classes, a nested list of methods with their own positions.

The outline is used for **hover**, **documentSymbol**, and can be reused for future features like go‑to‑definition.

---

## 6. Hover implementation

The `hover` method in `impl LanguageServer for Backend` works as follows:

1. It looks up the current document text from the `documents` map.

2. It finds the word under the cursor using `find_word_span`, which treats letters, digits, `_`, `:`, `/`, and `"` as word characters.

3. It strips surrounding quotes from the extracted word.

4. It builds an `Outline` from the full document text.

5. It constructs lookup maps from the outline:

   ```rust
   HashMap<String, FunctionOutline>
   HashMap<String, ClassOutline>
   HashMap<String, Vec<MethodOutline>>
   HashMap<String, Vec<EndpointOutline>>
   ```

6. It chooses hover text depending on the word:

   * `"server"` – explains the server declaration and shows the configured port (if known).
   * `"endpoint"` – explains endpoint syntax.
   * `"func"` – explains function definition syntax.
   * `"class"` – explains class syntax and methods.
   * `"GET"` / `"POST"` – describes HTTP methods and shows a Shrimpl example.
   * A known function name – shows the definition line.
   * A known class name – shows methods declared within the class.
   * A known method name – lists all definitions as `Class.method (line N)`.
   * A known endpoint path – lists all endpoints that use that path.

The result is returned as Markdown:

```rust
Hover {
    contents: HoverContents::Markup(MarkupContent {
        kind: MarkupKind::Markdown,
        value,
    }),
    range: None,
}
```

You can extend this logic to support more hover types or richer information using either the outline or full AST.

---

## 7. Completions

The server implements basic keyword completions via `completion`:

* `server <port>`
* `endpoint METHOD "/path": body`
* `func name(args): expr`
* `class Name:` and an indented method template
* HTTP methods `GET` and `POST`
* `json { "message": "Hello" }`

All completion items live in `keyword_completions()` and are returned as a `CompletionResponse::Array`.

To extend completions:

* Add more `CompletionItem` entries to `keyword_completions()`.
* Optionally make `completion` inspect the current text and cursor position to return context‑sensitive suggestions (e.g. only suggest `GET`/`POST` after `endpoint`).

---

## 8. Document symbols (Outline view)

`document_symbol` provides a structured outline to VS Code:

1. Fetches the document text from `documents`.

2. Builds an `Outline` via `parse_outline`.

3. Converts each entry into a `DocumentSymbol`:

   * `ServerOutline` → `SymbolKind::NAMESPACE` named `"server"`.
   * `EndpointOutline` → `SymbolKind::FUNCTION` named `"METHOD path"`.
   * `FunctionOutline` → `SymbolKind::FUNCTION` with detail `"func"`.
   * `ClassOutline` → `SymbolKind::CLASS` with children `SymbolKind::METHOD` for each method.

4. Returns `DocumentSymbolResponse::Nested(symbols)`.

This powers the Outline side bar and symbol navigation (`Ctrl+Shift+O` / `Cmd+Shift+O`).

---

## 9. Server capabilities and lifecycle

In `initialize`, the server declares:

```rust
ServerCapabilities {
    text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
    hover_provider: Some(HoverProviderCapability::Simple(true)),
    completion_provider: Some(CompletionOptions {
        resolve_provider: Some(false),
        trigger_characters: Some(vec![" ".into(), "/".into(), "\"".into(), ":".into()]),
        ..CompletionOptions::default()
    }),
    document_symbol_provider: Some(OneOf::Left(true)),
    ..ServerCapabilities::default()
}
```

Other lifecycle hooks:

* `initialized` – logs a short message (“Shrimpl LSP initialized. Watching .shr files.”).
* `shutdown` – currently a no‑op that returns `Ok(())`.

When you implement new LSP methods, update `ServerCapabilities` and add the corresponding async method to `impl LanguageServer for Backend`.

---

## 10. Getting started (development setup)

### 10.1 Prerequisites

* Node.js (LTS) + npm.
* VS Code.
* Rust stable toolchain (for `shrimpl-lsp`).

Clone both repositories:

```bash
git clone https://github.com/adl5423/shrimpl-language.git
git clone https://github.com/adl5423/lsp-shrimpl-lang.git
```

### 10.2 Build the `shrimpl-lsp` binary

From `shrimpl-language/`:

```bash
cargo build --bin shrimpl-lsp
```

Verify the binary exists:

```text
shrimpl-language/target/debug/shrimpl-lsp
```

### 10.3 Configure the extension to find `shrimpl-lsp`

Open the **`lsp-shrimpl-lang`** folder in VS Code and create or edit `.vscode/settings.json`:

```jsonc
{
  "shrimpl.lsp.path": "${workspaceFolder}/../shrimpl-language/target/debug/shrimpl-lsp"
}
```

Adjust the relative path as needed so it points to the compiled binary.

Alternatively, add the binary directory to your `PATH` and leave the setting unset:

```bash
export PATH="$PATH:/absolute/path/to/shrimpl-language/target/debug"
```

### 10.4 Install extension dependencies and compile

From `lsp-shrimpl-lang/`:

```bash
npm install
npm run compile   # or the equivalent build script in package.json
```

This produces `out/extension.js` used by VS Code.

### 10.5 Run and debug the extension

1. Open `lsp-shrimpl-lang` in VS Code.
2. Use the “Run and Debug” view and select “Run Extension” (from `.vscode/launch.json`).
3. Press `F5` – a new **Extension Development Host** window opens.
4. In that window, open a workspace that contains a Shrimpl file (`app.shr` or any `.shr`).
5. Open the file; the extension will start `shrimpl-lsp` and features (hover, diagnostics, completions, symbols) should become active.

For Rust-side debugging, instrument with logging (`eprintln!` or `tracing`) and inspect the Output panel in VS Code.

---

## 11. Making changes

### 11.1 Language changes (parser, diagnostics, semantics)

In most cases, changes to the Shrimpl language itself belong in the `shrimpl-language` repo:

1. Update the grammar and AST in `src/parser/*.rs`.
2. Update interpreter or docs in `src/interpreter` and `src/docs`.
3. If you add new diagnostics, expose them via `docs::build_diagnostics`.
4. The LSP will automatically surface these diagnostics because it already calls `docs::build_diagnostics(&program)`.

If you add location info (line/column) to the diagnostics JSON, extend `convert_static_diagnostics` to use it.

### 11.2 Extending hover

If the information you want is purely structural (e.g., more info about endpoints, classes, etc.), extend:

* `parse_outline` – capture the additional data.
* `hover` – use the new data to build richer Markdown.

For truly semantic information (type info, data flow, etc.), you may:

* Parse the file into a full `Program` in `hover` (or cache it alongside the text), and
* Use the AST to look up the node under the cursor.

### 11.3 Extending completions

To add new keyword snippets, edit `keyword_completions()` and append new `CompletionItem`s.

For context-sensitive completions:

* Inspect `CompletionParams` (position, document URI).
* Fetch and analyze the document text.
* Combine static snippets with dynamic suggestions (e.g., function names, class names, endpoint paths).

### 11.4 Adding new LSP methods

Example: go‑to‑definition.

1. Enable the capability in `initialize`:

   ```rust
   definition_provider: Some(OneOf::Left(true)),
   ```

2. Implement the method:

   ```rust
   async fn goto_definition(
       &self,
       params: GotoDefinitionParams,
   ) -> Result<Option<GotoDefinitionResponse>> {
       // 1) Get document text from self.documents
       // 2) Find symbol under cursor via find_word_span
       // 3) Use Outline or AST to find its definition range
       // 4) Return a Location or LocationLink
   }
   ```

3. Rebuild `shrimpl-lsp`, recompile the extension, and reload VS Code.

---

## 12. Coding style and CI expectations

For the Rust repo (`shrimpl-language`), CI expects:

```bash
cargo fmt --all
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all
```

Before opening a PR that touches `shrimpl-lsp` or any shared modules, run these locally and fix any warnings (we treat all clippy warnings as errors).

For the extension repo:

* Keep `extension.ts` clean and type-safe.

* Run the TypeScript build:

  ```bash
  npm run compile
  ```

* If linting is added, ensure it passes (e.g., `npm test` / `npm run lint`).

---

## 13. Troubleshooting

**Language server fails to start**

* Check the Output → Shrimpl channel in VS Code.
* Verify `shrimpl.lsp.path` is configured correctly or that `shrimpl-lsp` is on your `PATH`.
* Run the binary manually to ensure it’s executable:

  ```bash
  /absolute/path/to/shrimpl-lsp
  ```

**No diagnostics / hover / completions**

* Make sure the file has the `.shr` extension.
* Confirm that the language mode in VS Code is set to “Shrimpl”.
* Check the Output panel for JSON-RPC errors.

**Clippy or formatting failures when editing the LSP**

* Run `cargo fmt --all` before committing.
* Use `cargo clippy --all-targets --all-features -- -D warnings` and address each reported lint.

---

## 14. Contributing

Pull requests and issues are welcome. When contributing to the LSP:

1. Describe the feature or bugfix clearly.
2. Include tests where reasonable (parser, diagnostics, or small integration tests).
3. Keep changes logically grouped (LSP-only vs core-language changes).
4. Ensure both Rust and TypeScript builds succeed.

With this guide you should be able to:

* Understand how the Shrimpl LSP is wired end‑to‑end.
* Navigate the relevant Rust and TypeScript code paths.
* Implement new features (hover, completions, symbols, diagnostics).
* Run and debug the extension in a local VS Code dev environment.
