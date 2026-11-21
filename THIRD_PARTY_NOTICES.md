# Third-party components

## JobFindsMe adapter reference

The local BOSS直聘, 智联招聘, and 前程无忧 browser selectors, field mappings, and search request shapes were adapted from [JobFindsMe](https://github.com/russeell/jobfindsme), copyright (c) 2026 Russell. This workbench keeps platform login sessions on the user's computer and stops when a platform requires security verification. The upstream MIT license is reproduced in `third_party/jobfindsme-MIT.txt`.

The v0.13 page collector also references `apps/desktop/main/sources/boss-page.ts`, `boss-collector.ts`, and `zhilian-page.ts` for current search routes, visible card selectors and the Zhilian JobCard public position URL. No upstream credential storage or automatic application code is imported.

## ImapFlow 2.0.5 and MailParser 3.9.28

Unmodified npm dependencies for read-only IMAP access and MIME parsing. No SMTP sender is integrated.

- ImapFlow: https://github.com/postalsys/imapflow — MIT; full license retained in third_party/imapflow/LICENSE.txt.
- MailParser: https://github.com/nodemailer/mailparser — MIT; full license retained in third_party/mailparser/LICENSE.

These pinned dependencies are served locally, without CDN scripts or external telemetry. Original source distributions and license files remain in node_modules.

## Tabulator 6.3.1

Source: https://github.com/tabulator-tables/tabulator

The MIT License (MIT)

Copyright (c) 2015-2025 Oli Folkerd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## SortableJS 1.15.6

Source: https://github.com/SortableJS/Sortable

MIT License

Copyright (c) 2019 All contributors to Sortable

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


Node.js runtime distributions include the upstream LICENSE alongside node.exe. Additional npm dependencies retain their license files.

## Administrative-divisions-of-China city names

Source: https://github.com/modood/Administrative-divisions-of-China (2023 data snapshot, retrieved 2026-10-13).
License: WTFPL v2; full text retained in third_party/administrative-divisions-of-china/LICENSE.
public/recruitment-ui.js contains derived city names and city/district name collisions from dist/cities.json and dist/areas.json. Municipality names, Hong Kong, Macau and six Taiwan city names are supplemented locally. This is a local filter dictionary; no runtime network request or dependency is added. Unknown locations remain accessible under 未识别城市.
