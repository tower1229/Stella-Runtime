/* Generated from contracts/v1. Do not edit directly. */

export type ReasonCodes = string[];

export interface RuntimeRecoveryVerificationOrRestoreReport {
  report_schema_version: "cognitive-runtime.runtime-recovery-report/v1";
  operation: "verify" | "restore";
  compatibility_result: CheckResult;
  integrity_result: CheckResult;
  restored_active_head: null | {
    active_seq: number;
    state_view_version: string;
    checksum: string;
  };
  pending_outbox_state: {
    pending_count: number;
    in_flight_count: number;
  };
  storage_migrations_applied: string[];
  rollback_result: {
    status: "not_required" | "completed" | "failed";
    reason_codes: ReasonCodes;
  };
  projections_requiring_rebuild: string[];
}
export interface CheckResult {
  status: "pass" | "fail";
  reason_codes: ReasonCodes;
}
