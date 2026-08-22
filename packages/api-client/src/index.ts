// @unit-price/api-client — transport-agnostic shared API contract. Carries the
// GET /rankings and GET /categories contracts (Zod schemas + inferred types)
// plus pure helpers (buildRankingsUrl / parseRankingsSnapshot /
// buildCategoriesUrl / parseCategoryTreeResponse). NO network calls, NO runtime/
// framework dependency — only @unit-price/core + Zod. Each client wires its own
// transport. The single source of truth for these response schemas: apps/api
// and every client depend on this one definition.
export {
  RankingsItemSchema,
  type RankingsItem,
} from './rankings.js';
export {
  CategoryTreeNodeSchema,
  CategoryTreeResponseSchema,
  type CategoryTreeNode,
  type CategoryTreeResponse,
} from './categories.js';
// Board snapshot: the single cacheable object GET /rankings returns, plus the
// pure derivation every client uses to cut views out of it (cohort filter,
// search, paging). Deriving here — not per client — keeps one definition of
// what a cohort contains and what a search word matches.
export {
  SnapshotRowSchema,
  SnapshotViewRowSchema,
  SnapshotCategoryNodeSchema,
  RankingsSnapshotSchema,
  parseRankingsSnapshot,
  cohortSlugs,
  rowsInCohort,
  normalizeQuery,
  matchesQuery,
  pageOf,
  SEARCH_MIN_CODEPOINTS,
  SEARCH_MAX_CODEPOINTS,
  type SnapshotRow,
  type SnapshotViewRow,
  type SnapshotCategoryNode,
  type RankingsSnapshot,
  type CohortRejection,
} from './snapshot.js';
export {
  buildRankingsUrl,
  buildCategoriesUrl,
  parseCategoryTreeResponse,
} from './client.js';
export {
  ComputeUnitSchema,
  ComputeMeasurementSchema,
  ComputeRequestSchema,
  ComputeResultSchema,
  buildComputeUrl,
  parseComputeResponse,
  type ComputeUnit,
  type ComputeMeasurement,
  type ComputeRequest,
  type ComputeResult,
} from './compute.js';
