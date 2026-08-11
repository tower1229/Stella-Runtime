export interface RuntimeRecoveryPort<
  TBackupOptions = unknown,
  TVerifyOptions = unknown,
  TRestoreOptions = unknown,
  TSnapshot = unknown,
  TReport = unknown,
> {
  backup(options: TBackupOptions): Promise<TSnapshot>;
  verify(snapshot: TSnapshot, options: TVerifyOptions): Promise<TReport>;
  restore(snapshot: TSnapshot, options: TRestoreOptions): Promise<TReport>;
}
