/**
 * 九态生命周期（RFC-0001）
 *
 * @remarks
 * 值是状态名，JSON 编码即名字；序号（{@link lifecycleStateOrdinal}）与 .NET 枚举和插件协议的 LifecycleState 一致
 */
export const LifecycleState = Object.freeze({
  Declared: 'Declared',
  Resolved: 'Resolved',
  Configured: 'Configured',
  Started: 'Started',
  Ready: 'Ready',
  Degraded: 'Degraded',
  Draining: 'Draining',
  Stopped: 'Stopped',
  Failed: 'Failed',
} as const);

/**
 * 生命周期状态之一
 */
export type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];

/**
 * 全部状态，按序号排列
 */
export const lifecycleStates: readonly LifecycleState[] = Object.freeze([
  LifecycleState.Declared,
  LifecycleState.Resolved,
  LifecycleState.Configured,
  LifecycleState.Started,
  LifecycleState.Ready,
  LifecycleState.Degraded,
  LifecycleState.Draining,
  LifecycleState.Stopped,
  LifecycleState.Failed,
]);

/**
 * 合法迁移的完整列表（spec/conformance/vectors/primitives/lifecycle-transitions.json）；未列出的一律非法
 */
const transitions: ReadonlyMap<LifecycleState, readonly LifecycleState[]> = new Map([
  [LifecycleState.Declared, [LifecycleState.Resolved, LifecycleState.Failed]],
  [LifecycleState.Resolved, [LifecycleState.Configured, LifecycleState.Failed]],
  [LifecycleState.Configured, [LifecycleState.Started, LifecycleState.Failed]],
  [
    LifecycleState.Started,
    [LifecycleState.Ready, LifecycleState.Degraded, LifecycleState.Draining, LifecycleState.Failed],
  ],
  [LifecycleState.Ready, [LifecycleState.Degraded, LifecycleState.Draining, LifecycleState.Failed]],
  [LifecycleState.Degraded, [LifecycleState.Ready, LifecycleState.Draining, LifecycleState.Failed]],
  [LifecycleState.Draining, [LifecycleState.Stopped, LifecycleState.Failed]],
  [LifecycleState.Stopped, []],
  [LifecycleState.Failed, [LifecycleState.Resolved]],
]);

/**
 * 判断一个值是否是生命周期状态名（区分大小写）
 */
export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (lifecycleStates as readonly string[]).includes(value);
}

/**
 * 返回状态的序号：Declared 为 0，Failed 为 8
 */
export function lifecycleStateOrdinal(state: LifecycleState): number {
  return lifecycleStates.indexOf(state);
}

/**
 * 按序号取状态；序号不对应任何状态时为 `undefined`
 */
export function lifecycleStateFromOrdinal(ordinal: number): LifecycleState | undefined {
  return Number.isInteger(ordinal) ? lifecycleStates[ordinal] : undefined;
}

/**
 * 判断从 `from` 到 `to` 的迁移是否合法
 */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return transitions.get(from)?.includes(to) ?? false;
}

/**
 * 判断状态是否可服务：Ready 或 Degraded
 */
export function isServing(state: LifecycleState): boolean {
  return state === LifecycleState.Ready || state === LifecycleState.Degraded;
}

/**
 * 判断状态是否是终态：Stopped
 */
export function isTerminal(state: LifecycleState): boolean {
  return state === LifecycleState.Stopped;
}
