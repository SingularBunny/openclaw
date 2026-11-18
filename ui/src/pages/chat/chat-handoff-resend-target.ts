// Fork: which model a picker choice hands the chat to. Bound to an ACP agent, a named model unbinds
// it first; while a failed turn waits to be re-sent ("Choose another model"), every choice hands
// off, the default row included, which commits no model of its own and so names the default.
export function pickerHandoffModel(
  next: string | null | undefined,
  opts: { bound: boolean; resend: string | undefined; defaultModel: string | undefined },
): string | undefined {
  if (opts.resend) {
    return next || opts.defaultModel || undefined;
  }
  return next && opts.bound ? next : undefined;
}
