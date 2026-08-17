export enum ApproveRequiredReason {
  Unsupported, // f.e. eth flow without bundling or for limit orders
  NotRequired,
  Required,
  Eip2612PermitRequired,
  DaiLikePermitRequired,
  BundleApproveRequired,
}
