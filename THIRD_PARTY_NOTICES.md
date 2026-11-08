# Third-Party Notices

`Aiken-harnes` itself is licensed under the MIT License (see `LICENSE`).

This project depends on the following third-party packages. Their licenses and
copyright notices are reproduced or referenced below. The corresponding full
license texts are in `LICENSES/`.

## Runtime dependencies

### Apache-2.0

| Package | Version | Copyright / attribution | Upstream |
|---|---|---|---|
| `@material/web` | 2.5.0 | Google LLC; see the copyright headers in the package source | https://github.com/material-components/material-web |
| `@material/material-color-utilities` | 0.4.0 | Google LLC; see the copyright headers in the package source | https://github.com/material-foundation/material-color-utilities |

- License text: `LICENSES/Apache-2.0.txt`
- Neither package ships a separate NOTICE file in the installed version.

### BSD-3-Clause

| Package | Version | Copyright | Upstream |
|---|---|---|---|
| `lit` | 3.3.3 | Copyright (c) 2017 Google LLC. All rights reserved. | https://github.com/lit/lit |
| `lit-element` | 4.2.2 | Copyright (c) 2017 Google LLC. All rights reserved. | https://github.com/lit/lit |
| `lit-html` | 3.3.3 | Copyright (c) 2017 Google LLC. All rights reserved. | https://github.com/lit/lit |
| `@lit/context` | 1.1.6 | Copyright Google LLC; see package source | https://github.com/lit/lit |
| `@lit/reactive-element` | 2.1.2 | Copyright Google LLC; see package source | https://github.com/lit/lit |
| `@lit-labs/ssr-dom-shim` | 1.6.0 | Copyright Google LLC; see package source | https://github.com/lit/lit |

- License text: `LICENSES/BSD-3-Clause.txt`

### MIT

| Package | Version | Copyright | Upstream |
|---|---|---|---|
| `zod` | 4.6.7 | Copyright (c) 2025 Colin McDonnell | https://github.com/colinhacks/zod |

- License text: `LICENSES/MIT.txt`

### 0BSD

| Package | Version | Upstream |
|---|---|---|
| `tslib` | 2.9.1 | https://github.com/microsoft/tslib |

- License text: `LICENSES/0BSD.txt`

## Development and type-only dependencies

These are used for building, type checking, and tests. They are not included
in the generated browser bundle.

| Package | Version | License | Copyright / upstream |
|---|---|---|---|
| `typescript` | 7.0.2 | Apache-2.0 | Microsoft; https://github.com/microsoft/TypeScript |
| `@typescript/typescript-linux-x64` | 7.0.2 | Apache-2.0 | Microsoft; TypeScript distribution |
| `@types/bun` | 1.4.4 | MIT | Bun contributors; https://github.com/oven-sh/bun |
| `bun-types` | 1.4.4 | MIT | Bun contributors; https://github.com/oven-sh/bun |
| `@types/node` | 26.6.6 | MIT | DefinitelyTyped contributors; https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/trusted-types` | 2.0.7 | MIT | DefinitelyTyped contributors; https://github.com/DefinitelyTyped/DefinitelyTyped |
| `undici-types` | 8.12.4 / 8.9.0 | MIT | Undici contributors; https://github.com/nodejs/undici |
| `vscode-jsonrpc` | 9.0.0 | MIT | Microsoft; https://github.com/microsoft/vscode-languageserver-node |

- Apache-2.0 text: `LICENSES/Apache-2.0.txt`
- TypeScript NOTICE: `LICENSES/TypeScript-NOTICE.txt`
- MIT text: `LICENSES/MIT.txt`

## Runtime

The project is designed to run on Bun. Bun is licensed under the MIT License.
See https://github.com/oven-sh/bun for details.

## Distribution note

The Web UI can bundle `@material/web`, `lit`, and their dependencies into a
single browser JavaScript file at runtime. If you distribute that bundle or
host the UI for others, include this file and the relevant files in `LICENSES/`
with the distribution.

This notice is provided for attribution and compliance convenience. It does not
replace the full license texts.
