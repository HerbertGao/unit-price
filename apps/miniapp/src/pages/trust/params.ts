// Route helpers for the trust page. Pure so they can be tested without Taro.
import { LANDING_COHORT } from '../index/config';

function decodeOnce(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Cohort the list was showing. A blank route param falls back to the landing board. */
export function trustCohortSlug(category: string | undefined): string {
  const trimmed = category?.trim() ?? '';
  return trimmed === '' ? LANDING_COHORT : trimmed;
}

export function trustPageUrl(id: string, cohort: string): string {
  return `/pages/trust/index?id=${encodeURIComponent(id)}&cohort=${encodeURIComponent(cohort)}`;
}

export function readTrustParams(p: { id?: string; cohort?: string }): {
  id: string | undefined;
  cohort: string | undefined;
} {
  const id = p.id ? decodeOnce(p.id).trim() : '';
  const cohort = p.cohort ? decodeOnce(p.cohort).trim() : '';
  return {
    id: id === '' ? undefined : id,
    cohort: cohort === '' ? undefined : cohort,
  };
}
