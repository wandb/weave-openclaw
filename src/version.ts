// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

/**
 * Package identity constants. Kept in a dedicated tiny file so the
 * automated version-bump bot's commits don't churn `service.ts` —
 * see `scripts/release/bump-version.mjs` and
 * `.github/workflows/publish.yml` (which read the version from here).
 *
 * Do not inline the literal anywhere else in the codebase — import
 * from this module so a single edit propagates.
 */
export const PACKAGE_NAME = "weave-openclaw";
export const PACKAGE_VERSION = "0.0.2";
