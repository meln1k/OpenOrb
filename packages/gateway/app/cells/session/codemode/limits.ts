/** QuickJS heap of one codemode execution. */
export const CODEMODE_MEMORY_BYTES = 32 * 1024 * 1024;
/**
 * Interrupt polls one execution may use: the cooperative stop for a script that computes without
 * calling a tool. The facet's CPU limit backstops it.
 */
export const CODEMODE_INTERRUPT_BUDGET = 1_000;
